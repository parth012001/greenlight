import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { appendAudit } from "@/lib/audit";
import { matchPolicy, type PolicyInput } from "@/lib/policy";
import { safeJsonParse } from "@/lib/json";
import { buildProposalPayload } from "@/lib/graduation";
import { DEFAULT_THRESHOLD, TRUST_THRESHOLDS } from "@/lib/trust";
import { shapeKeyOf, type ActionShape } from "@/lib/shapes";
import type { ActionKind } from "@/lib/connectors/types";

// The pattern miner: the complement to the streak engine in trust.ts. The streak
// engine is online accounting — it only sees approvals it watched happen, in an
// uninterrupted run. The miner sweeps recorded history (including history that
// predates the trust ledger) for shapes that recurred cleanly and STILL route to
// a human, and surfaces them as candidates. Nothing activates from here: promote
// creates a GraduationProposal through the exact same machinery a streak earns,
// and a human accepts or declines it.

type Db = Prisma.TransactionClient | typeof prisma;

export const MINING_WINDOW_DAYS = 30;

const MAX_TX_RETRIES = 5;

// Local copy of the shared helper — same module-cycle reasoning as trust.ts.
function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface SuggestionCandidate {
  shapeKey: string;
  shape: ActionShape;
  // Clean human-approved executions inside the window. A "clean occurrence" is
  // an executed run whose approval a human granted — auto-approved runs earn
  // nothing here, exactly as they earn no streak.
  occurrences: number;
  threshold: number;
  ticketNumbers: number[]; // evidence, oldest first
  lastSeenAt: Date;
  // The rule currently forcing this shape to a human (null id = default-closed).
  blockedBy: { policyId: string | null; name: string };
}

function toPolicyInput(shape: ActionShape): PolicyInput {
  return {
    kind: shape.kind,
    appId: shape.appId ?? undefined,
    level: shape.level ?? undefined,
    role: shape.role,
  };
}

// Sweep terminal action history inside the window and group by the same
// (kind, appId, level, role) tuple the policy engine matches on. A shape
// qualifies when it recurred cleanly at least threshold times, had NO denial or
// failure in the window (a recent human "no" or a fault disqualifies outright),
// still routes to require_approval, and isn't already proposed or autonomous.
// Queries run sequentially so this works inside an interactive transaction.
export async function mineSuggestions(db: Db = prisma): Promise<SuggestionCandidate[]> {
  const windowStart = new Date(Date.now() - MINING_WINDOW_DAYS * 86_400_000);

  const enabled = await db.policy.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });
  const runs = await db.actionRun.findMany({
    where: {
      createdAt: { gte: windowStart },
      status: { in: ["executed", "failed", "denied"] },
    },
    orderBy: { createdAt: "asc" },
    include: {
      approval: { select: { status: true } },
      ticket: {
        select: { number: true, requester: { select: { role: true } } },
      },
    },
  });
  const states = await db.trustState.findMany({
    select: { shapeKey: true, status: true },
  });
  const pending = await db.graduationProposal.findMany({
    where: { status: "pending" },
    select: { shapeKey: true },
  });

  const excluded = new Set<string>(pending.map((p) => p.shapeKey));
  for (const s of states) {
    if (s.status === "proposed" || s.status === "autonomous") excluded.add(s.shapeKey);
  }

  const buckets = new Map<
    string,
    {
      shape: ActionShape;
      clean: Array<{ ticketNumber: number; at: Date }>;
      disqualified: boolean;
    }
  >();
  for (const run of runs) {
    const parsed = safeJsonParse<{ appId?: string; level?: string } | null>(
      run.input,
      null,
    );
    if (!parsed) continue;
    const shape: ActionShape = {
      kind: run.kind as ActionKind,
      appId: parsed.appId ?? null,
      level: parsed.level ?? null,
      role: run.ticket.requester.role,
    };
    const key = shapeKeyOf(shape);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { shape, clean: [], disqualified: false };
      buckets.set(key, bucket);
    }
    if (run.status === "executed" && run.approval?.status === "approved") {
      bucket.clean.push({ ticketNumber: run.ticket.number, at: run.createdAt });
    } else if (run.status === "failed" || run.status === "denied") {
      bucket.disqualified = true;
    }
    // Executed with no approval = it ran autonomously: neither evidence nor a strike.
  }

  const candidates: SuggestionCandidate[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.disqualified || excluded.has(key)) continue;
    const threshold = TRUST_THRESHOLDS[bucket.shape.kind] ?? DEFAULT_THRESHOLD;
    if (bucket.clean.length < threshold) continue;
    const decision = matchPolicy(toPolicyInput(bucket.shape), enabled);
    if (decision.effect !== "require_approval") continue;
    candidates.push({
      shapeKey: key,
      shape: bucket.shape,
      occurrences: bucket.clean.length,
      threshold,
      ticketNumbers: bucket.clean.map((c) => c.ticketNumber),
      lastSeenAt: bucket.clean[bucket.clean.length - 1].at,
      blockedBy: { policyId: decision.policyId, name: decision.policyName },
    });
  }

  candidates.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
  );
  return candidates;
}

export type PromoteResult =
  | { status: "promoted"; proposalId: string }
  | { status: "conflict"; reason: string };

// Promote = an admin asks the system to draft the proposal. Mirrors
// maybeProposeGraduation's lockstep exactly — TrustState is claimed into
// "proposed" atomically before the proposal row exists, so acceptGraduation's
// invariant (exactly one "proposed" row to flip) holds for mined proposals too.
// The candidate is re-mined inside the transaction: anything that changed since
// the admin's screen rendered (a denial landed, a policy moved, another admin
// promoted first) surfaces as a conflict instead of a stale artifact.
export async function promoteSuggestion(
  shapeKey: string,
  adminId: string,
): Promise<PromoteResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx): Promise<PromoteResult> => {
          const candidates = await mineSuggestions(tx);
          const candidate = candidates.find((c) => c.shapeKey === shapeKey);
          if (!candidate) {
            return {
              status: "conflict",
              reason:
                "This pattern is no longer a suggestion candidate — history or policies changed since it was surfaced.",
            };
          }
          const { shape, occurrences, threshold, ticketNumbers } = candidate;

          // Mined shapes often predate the trust ledger entirely — create the
          // row on first contact, same threshold snapshot as the streak path.
          const prior = await tx.trustState.upsert({
            where: { shapeKey },
            create: {
              shapeKey,
              kind: shape.kind,
              appId: shape.appId ?? null,
              level: shape.level ?? null,
              role: shape.role,
              threshold,
            },
            update: {},
          });
          const claimed = await tx.trustState.updateMany({
            where: { shapeKey, status: { in: ["supervised", "demoted"] } },
            data: { status: "proposed" },
          });
          if (claimed.count !== 1) {
            return {
              status: "conflict",
              reason: `Shape is already ${prior.status} — nothing to promote.`,
            };
          }

          const { policyName, impactPreview } = await buildProposalPayload(
            shape,
            tx,
          );
          if (impactPreview.diff.before.effect !== "require_approval") {
            // Re-mining above already checked this; re-checking under the claim
            // keeps the lockstep invariant self-contained (as in trust.ts).
            await tx.trustState.update({
              where: { shapeKey },
              data: { status: prior.status },
            });
            return {
              status: "conflict",
              reason: `Shape now resolves to ${impactPreview.diff.before.effect} — nothing to graduate.`,
            };
          }

          const proposal = await tx.graduationProposal.create({
            data: {
              shapeKey,
              kind: shape.kind,
              appId: shape.appId ?? null,
              level: shape.level ?? null,
              role: shape.role,
              policyName,
              source: "pattern_miner",
              // Same keys the streak path writes, so one ProposalCard renders both.
              evidence: JSON.stringify({
                streak: occurrences,
                threshold,
                ticketNumbers,
                windowDays: MINING_WINDOW_DAYS,
              }),
              impactPreview: JSON.stringify(impactPreview),
            },
          });
          await appendAudit(
            {
              actorType: "admin",
              actorId: adminId,
              action: "graduation.proposed",
              targetType: "proposal",
              targetId: proposal.id,
              detail: {
                via: "pattern_miner",
                shapeKey,
                occurrences,
                windowDays: MINING_WINDOW_DAYS,
                policyName,
              },
            },
            tx,
          );
          return { status: "promoted", proposalId: proposal.id };
        },
        { timeout: 10000 },
      );
    } catch (err) {
      if (isUniqueConflict(err) && attempt < MAX_TX_RETRIES) continue;
      throw err;
    }
  }
}
