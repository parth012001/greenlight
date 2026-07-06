import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { appendAudit } from "@/lib/audit";
import {
  matchPolicy,
  type PolicyEffect,
  type PolicyInput,
  type PolicyRule,
} from "@/lib/policy";
import { safeJsonParse } from "@/lib/json";
import {
  describeShape,
  shapeKeyOf,
  shapeKeySlug,
  type ActionShape,
} from "@/lib/shapes";
import type { ActionKind } from "@/lib/connectors/types";

// The graduation engine: turns an earned streak into a reviewable policy change.
// The artifact the admin decides on is a DIFF plus a REPLAY — terraform-plan for
// policy. Accepting applies the exact rule stored on the proposal (never
// re-derived), and a proposal whose policy environment shifted goes stale
// instead of being applied.

type Db = Prisma.TransactionClient | typeof prisma;

// How many recent actions the impact replay evaluates. Seed data must keep the
// total number of terminal runs under this, or replay previews silently stop
// seeing the oldest seeded evidence (a test pins the seed budget to it).
export const REPLAY_WINDOW = 50;

export interface RuleDiff {
  // The rule that currently gates the shape (null policyId = the default-closed rule).
  before: { policyId: string | null; name: string; effect: PolicyEffect };
  // The maximally-narrow auto_approve rule accept would insert — all four match
  // fields pinned, so trust earned by one shape can never widen to another.
  after: {
    name: string;
    effect: "auto_approve";
    kind: string;
    appId: string | null;
    level: string | null;
    role: string;
    insertBeforePolicyId: string | null; // null = append at the end
  };
}

export interface ReplaySummary {
  runsEvaluated: number;
  skipped: number;
  changed: number;
  flips: Array<{
    ticketNumber: number;
    shapeKey: string;
    from: PolicyEffect;
    to: PolicyEffect;
  }>;
  onlyTargetShapeChanges: boolean;
}

export interface ImpactPreview {
  diff: RuleDiff;
  replay: ReplaySummary;
  computedAt: string;
}

function toPolicyInput(shape: ActionShape): PolicyInput {
  return {
    kind: shape.kind,
    appId: shape.appId ?? undefined,
    level: shape.level ?? undefined,
    role: shape.role,
  };
}

// The blocker is the first enabled rule that currently matches the shape — the
// graduated rule must sort BEFORE it or first-match-wins never reaches it (e.g.
// contractor-gate at sortOrder 10 shadows every CONTRACTOR shape). No blocker
// (default decision) → the new rule can go last.
function findBlocker(
  shape: ActionShape,
  enabledPolicies: PolicyRule[],
): PolicyRule | null {
  const decision = matchPolicy(toPolicyInput(shape), enabledPolicies);
  if (!decision.policyId) return null;
  return enabledPolicies.find((p) => p.id === decision.policyId) ?? null;
}

// Build the decision artifact: rule diff + historical replay. Replay compares
// every recent action's decision under the current rules vs. current + candidate,
// entirely in memory (matchPolicy is pure) — the candidate gets a fractional
// sortOrder just below its blocker, which is never persisted.
export async function buildProposalPayload(
  shape: ActionShape,
  db: Db = prisma,
): Promise<{ policyName: string; impactPreview: ImpactPreview }> {
  const enabled = await db.policy.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });
  const before = matchPolicy(toPolicyInput(shape), enabled);
  const blocker = findBlocker(shape, enabled);

  const app = shape.appId
    ? await db.app.findUnique({ where: { id: shape.appId } })
    : null;
  const policyName = `Graduated: ${describeShape(shape, app?.name)}`;

  const candidate: PolicyRule = {
    id: "__candidate__",
    name: policyName,
    kind: shape.kind,
    appId: shape.appId ?? null,
    level: shape.level ?? null,
    role: shape.role,
    effect: "auto_approve",
    sortOrder: blocker
      ? blocker.sortOrder - 0.5
      : Math.max(0, ...enabled.map((p) => p.sortOrder)) + 10,
    enabled: true,
  };
  const proposed = [...enabled, candidate];

  const runs = await db.actionRun.findMany({
    orderBy: { createdAt: "desc" },
    take: REPLAY_WINDOW,
    include: {
      ticket: { include: { requester: { select: { role: true } } } },
    },
  });

  const targetKey = shapeKeyOf(shape);
  let skipped = 0;
  let changed = 0;
  let onlyTargetShapeChanges = true;
  const flips: ReplaySummary["flips"] = [];

  for (const run of runs) {
    const parsed = safeJsonParse<{ appId?: string; level?: string } | null>(
      run.input,
      null,
    );
    if (!parsed) {
      skipped++;
      continue;
    }
    const input: PolicyInput = {
      kind: run.kind as ActionKind,
      appId: parsed.appId,
      level: parsed.level,
      role: run.ticket.requester.role,
    };
    const was = matchPolicy(input, enabled);
    const would = matchPolicy(input, proposed);
    if (was.effect !== would.effect) {
      changed++;
      const runKey = shapeKeyOf({
        kind: input.kind,
        appId: input.appId ?? null,
        level: input.level ?? null,
        role: input.role,
      });
      if (runKey !== targetKey) onlyTargetShapeChanges = false;
      if (flips.length < 10) {
        flips.push({
          ticketNumber: run.ticket.number,
          shapeKey: runKey,
          from: was.effect,
          to: would.effect,
        });
      }
    }
  }

  return {
    policyName,
    impactPreview: {
      diff: {
        before: {
          policyId: before.policyId,
          name: before.policyName,
          effect: before.effect,
        },
        after: {
          name: policyName,
          effect: "auto_approve",
          kind: shape.kind,
          appId: shape.appId ?? null,
          level: shape.level ?? null,
          role: shape.role,
          insertBeforePolicyId: blocker?.id ?? null,
        },
      },
      replay: {
        runsEvaluated: runs.length,
        skipped,
        changed,
        flips,
        onlyTargetShapeChanges,
      },
      computedAt: new Date().toISOString(),
    },
  };
}

const MAX_TX_RETRIES = 5;

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export type AcceptResult =
  | { status: "accepted"; policyId: string }
  | { status: "stale"; reason: string };

// Accept = apply exactly what was reviewed. Staleness is checked FIRST against
// the live policy table: if the shape no longer routes to a human (someone
// hand-added an auto rule, or disabled the gate), the reviewed diff no longer
// describes reality and the proposal dies instead of being applied.
export async function acceptGraduation(
  proposalId: string,
  adminId: string,
  note?: string,
): Promise<AcceptResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx): Promise<AcceptResult> => {
          const proposal = await tx.graduationProposal.findUniqueOrThrow({
            where: { id: proposalId },
          });
          const shape: ActionShape = {
            kind: proposal.kind as ActionKind,
            appId: proposal.appId,
            level: proposal.level,
            role: proposal.role,
          };

          const enabled = await tx.policy.findMany({
            where: { enabled: true },
            orderBy: { sortOrder: "asc" },
          });
          const current = matchPolicy(toPolicyInput(shape), enabled);
          if (current.effect !== "require_approval") {
            const marked = await tx.graduationProposal.updateMany({
              where: { id: proposalId, status: "pending" },
              data: {
                status: "stale",
                decidedBy: adminId,
                decidedAt: new Date(),
                deciderNote: `policy environment changed: shape now resolves to ${current.effect} via "${current.policyName}"`,
              },
            });
            if (marked.count !== 1) {
              throw new Error(`Proposal ${proposalId} already resolved`);
            }
            // The streak itself wasn't overridden — the environment moved. The
            // shape goes back to supervised with its evidence intact.
            await tx.trustState.updateMany({
              where: { shapeKey: proposal.shapeKey, status: "proposed" },
              data: { status: "supervised" },
            });
            await appendAudit(
              {
                actorType: "system",
                actorId: "trust-engine",
                action: "graduation.stale",
                targetType: "proposal",
                targetId: proposalId,
                detail: {
                  shapeKey: proposal.shapeKey,
                  attemptedBy: adminId,
                  reason: `shape now resolves to ${current.effect}`,
                  rule: current.policyName,
                },
              },
              tx,
            );
            return {
              status: "stale",
              reason: `The policy environment changed since this was proposed — the shape now resolves to ${current.effect} via "${current.policyName}".`,
            };
          }

          const claimed = await tx.graduationProposal.updateMany({
            where: { id: proposalId, status: "pending" },
            data: {
              status: "accepted",
              decidedBy: adminId,
              decidedAt: new Date(),
              deciderNote: note,
            },
          });
          if (claimed.count !== 1) {
            throw new Error(`Proposal ${proposalId} already resolved`);
          }

          // Placement is recomputed against the LIVE table; the rule's match
          // fields come from the STORED proposal. Both on purpose.
          const all = await tx.policy.findMany({ orderBy: { sortOrder: "asc" } });
          const blocker = findBlocker(shape, enabled);

          const baseId = `grad-${shapeKeySlug(proposal.shapeKey)}`;
          const priorGraduations = await tx.policy.count({
            where: { id: { startsWith: baseId } },
          });
          const policyId =
            priorGraduations === 0 ? baseId : `${baseId}-${priorGraduations + 1}`;

          const evidence = safeJsonParse<{
            streak?: number;
            ticketNumbers?: number[];
          }>(proposal.evidence, {});
          const evidenceTickets = (evidence.ticketNumbers ?? [])
            .map((n) => `TKT-${n}`)
            .join(", ");
          await tx.policy.create({
            data: {
              id: policyId,
              name: proposal.policyName,
              description: `Auto-approve earned after ${evidence.streak ?? "?"} clean approvals with no overrides (${evidenceTickets}). Created by autonomy graduation — revoke from the Trust tab.`,
              kind: proposal.kind,
              appId: proposal.appId,
              level: proposal.level,
              role: proposal.role,
              effect: "auto_approve",
              sortOrder: 0, // placeholder — renumbered below
              enabled: true,
            },
          });

          // Splice the new rule in immediately before its blocker (or at the
          // end) and renumber the whole table back to 10, 20, 30… — a handful of
          // rows, and deterministic order keeps this deadlock-safe on Postgres.
          const insertIdx = blocker
            ? all.findIndex((p) => p.id === blocker.id)
            : all.length;
          const orderedIds = [
            ...all.slice(0, insertIdx).map((p) => p.id),
            policyId,
            ...all.slice(insertIdx).map((p) => p.id),
          ];
          for (let i = 0; i < orderedIds.length; i++) {
            await tx.policy.update({
              where: { id: orderedIds[i] },
              data: { sortOrder: (i + 1) * 10 },
            });
          }

          const trust = await tx.trustState.updateMany({
            where: { shapeKey: proposal.shapeKey, status: "proposed" },
            data: { status: "autonomous", graduatedPolicyId: policyId },
          });
          if (trust.count !== 1) {
            // Statuses move in lockstep with proposals by construction — a
            // mismatch is a bug worth surfacing, and the throw rolls it all back.
            throw new Error(
              `TrustState for ${proposal.shapeKey} was not in "proposed" state`,
            );
          }

          await appendAudit(
            {
              actorType: "admin",
              actorId: adminId,
              action: "graduation.accepted",
              targetType: "proposal",
              targetId: proposalId,
              detail: { shapeKey: proposal.shapeKey, policyId, note },
            },
            tx,
          );
          await appendAudit(
            {
              actorType: "system",
              actorId: "trust-engine",
              action: "policy.created",
              targetType: "policy",
              targetId: policyId,
              detail: { via: "graduation", proposalId, name: proposal.policyName },
            },
            tx,
          );
          return { status: "accepted", policyId };
        },
        { timeout: 10000 },
      );
    } catch (err) {
      if (isUniqueConflict(err) && attempt < MAX_TX_RETRIES) continue;
      throw err;
    }
  }
}

// Decline = the human says "not yet". The streak resets — autonomy is re-earned
// in full, there is no fast lane back to a proposal.
export async function declineGraduation(
  proposalId: string,
  adminId: string,
  note?: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const proposal = await tx.graduationProposal.findUniqueOrThrow({
            where: { id: proposalId },
          });
          const claimed = await tx.graduationProposal.updateMany({
            where: { id: proposalId, status: "pending" },
            data: {
              status: "declined",
              decidedBy: adminId,
              decidedAt: new Date(),
              deciderNote: note,
            },
          });
          if (claimed.count !== 1) {
            throw new Error(`Proposal ${proposalId} already resolved`);
          }
          await tx.trustState.updateMany({
            where: { shapeKey: proposal.shapeKey, status: "proposed" },
            data: {
              status: "supervised",
              cleanStreak: 0,
              streakTicketNumbers: "[]",
            },
          });
          await appendAudit(
            {
              actorType: "admin",
              actorId: adminId,
              action: "graduation.declined",
              targetType: "proposal",
              targetId: proposalId,
              detail: { shapeKey: proposal.shapeKey, note },
            },
            tx,
          );
        },
        { timeout: 10000 },
      );
      return;
    } catch (err) {
      if (isUniqueConflict(err) && attempt < MAX_TX_RETRIES) continue;
      throw err;
    }
  }
}
