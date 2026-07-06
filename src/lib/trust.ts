import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { appendAudit } from "@/lib/audit";
import { safeJsonParse } from "@/lib/json";
import type { ActionKind } from "@/lib/connectors/types";

// Trust is earned per action SHAPE — the exact (kind, appId, level, role) tuple
// evaluatePolicy matches on — never per agent. Every shape starts supervised;
// clean approvals build a streak toward the kind's threshold, any override resets
// it, and autonomy, once granted, is revoked by a single bad run. The ledger here
// is a materialized view of the audit trail: each row's evidence tickets point
// back into the hash chain.

// Promotion bars, declared up front (evidence-driven, never calendar-driven).
// Riskier kinds carry a higher bar. Snapshotted onto TrustState at creation so a
// later config change can't silently move the goalposts under an earned streak.
export const TRUST_THRESHOLDS: Record<ActionKind, number> = {
  grant_access: 3,
  provision_license: 3,
  reset_password: 3,
  revoke_access: 5,
};
const DEFAULT_THRESHOLD = 3;

export interface ActionShape {
  kind: ActionKind;
  appId?: string | null;
  level?: string | null;
  role: string;
}

// "grant_access:airtable:editor:GTM" — "-" for absent parts. A computed string key
// because SQLite compound uniques don't enforce NULL uniqueness (idempotencyKey idiom).
export function shapeKeyOf(shape: ActionShape): string {
  return [shape.kind, shape.appId ?? "-", shape.level ?? "-", shape.role].join(":");
}

// Policy-id-safe slug: "grant-access-airtable-editor-gtm"
export function shapeKeySlug(shapeKey: string): string {
  return shapeKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function describeShape(shape: ActionShape, appName?: string): string {
  const app = appName ?? shape.appId ?? "";
  switch (shape.kind) {
    case "grant_access":
      return `${shape.role} · ${(shape.level ?? "").replace("_", "-")} access to ${app}`;
    case "revoke_access":
      return `${shape.role} · revoke access to ${app}`;
    case "reset_password":
      return `${shape.role} · password reset`;
    case "provision_license":
      return `${shape.role} · ${app} license`;
  }
}

const MAX_TX_RETRIES = 5;

// Local copy of the actions.ts helper — importing it would create a module cycle
// (actions.ts imports this file for the accounting hooks).
function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export interface SupervisedOutcome {
  shape: ActionShape;
  outcome: "clean" | "denied" | "failed";
  ticketNumber: number;
  approverId: string;
}

// Called after every human-resolved approval. One transaction (with the repo's
// P2002 retry idiom — covers audit-chain forks and concurrent first-creation of
// the same shapeKey). Semantics:
//   clean  → streak +1, evidence ticket recorded (unless already autonomous:
//            a pre-graduation approval resolving late still counts toward totals
//            but no longer earns the streak)
//   denied → streak resets; a pending proposal for the shape goes stale (the
//            override invalidates its evidence)
//   failed → the human approved but execution failed: counts as an approval,
//            still interrupts the clean streak
export async function recordSupervisedOutcome(
  input: SupervisedOutcome,
): Promise<void> {
  const shapeKey = shapeKeyOf(input.shape);
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const state = await tx.trustState.upsert({
            where: { shapeKey },
            create: {
              shapeKey,
              kind: input.shape.kind,
              appId: input.shape.appId ?? null,
              level: input.shape.level ?? null,
              role: input.shape.role,
              threshold: TRUST_THRESHOLDS[input.shape.kind] ?? DEFAULT_THRESHOLD,
            },
            update: {},
          });

          if (input.outcome === "clean") {
            if (state.status === "autonomous") {
              await tx.trustState.update({
                where: { shapeKey },
                data: { totalApproved: { increment: 1 } },
              });
              return;
            }
            const tickets = safeJsonParse<number[]>(state.streakTicketNumbers, []);
            await tx.trustState.update({
              where: { shapeKey },
              data: {
                cleanStreak: { increment: 1 },
                totalApproved: { increment: 1 },
                streakTicketNumbers: JSON.stringify([...tickets, input.ticketNumber]),
              },
            });
            await maybeProposeGraduation(tx, shapeKey);
            return;
          }

          if (input.outcome === "denied") {
            await tx.trustState.update({
              where: { shapeKey },
              data: {
                cleanStreak: 0,
                streakTicketNumbers: "[]",
                totalDenied: { increment: 1 },
              },
            });
            const invalidated = await tx.graduationProposal.updateMany({
              where: { shapeKey, status: "pending" },
              data: { status: "stale", deciderNote: "denied during review" },
            });
            if (invalidated.count > 0) {
              await tx.trustState.updateMany({
                where: { shapeKey, status: "proposed" },
                data: { status: "supervised" },
              });
              await appendAudit(
                {
                  actorType: "system",
                  actorId: "trust-engine",
                  action: "graduation.stale",
                  targetType: "shape",
                  targetId: shapeKey,
                  detail: {
                    reason: "denied_during_review",
                    ticketNumber: input.ticketNumber,
                    deniedBy: input.approverId,
                  },
                },
                tx,
              );
            }
            return;
          }

          // failed
          await tx.trustState.update({
            where: { shapeKey },
            data: {
              cleanStreak: 0,
              streakTicketNumbers: "[]",
              totalApproved: { increment: 1 },
            },
          });
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

// Placeholder until the graduation engine lands: the trigger point is here (inside
// the same transaction that bumps the streak) so threshold-crossing and proposal
// creation can never race apart.
async function maybeProposeGraduation(
  _tx: Prisma.TransactionClient,
  _shapeKey: string,
): Promise<void> {}

// Called after every agent-initiated (auto-approved) execution. Only shapes whose
// auto_approve rule came from graduation are tracked — the graduatedPolicyId link
// is the authoritative test, no id-prefix parsing.
export async function recordAutonomousOutcome(input: {
  policyId: string;
  ok: boolean;
  ticketId: string;
  ticketNumber: number;
}): Promise<void> {
  const state = await prisma.trustState.findFirst({
    where: { graduatedPolicyId: input.policyId, status: "autonomous" },
  });
  if (!state) return;

  if (input.ok) {
    await prisma.trustState.updateMany({
      where: { shapeKey: state.shapeKey, status: "autonomous" },
      data: { autonomousRuns: { increment: 1 } },
    });
    return;
  }

  // Trust is losable: one bad autonomous run revokes it. The shape falls back to
  // its original require_approval rule and re-earns the full streak — no fast lane.
  await demoteShape({
    shapeKey: state.shapeKey,
    actor: { type: "system", id: "trust-engine" },
    reason: "autonomous_execution_failed",
    ticketId: input.ticketId,
    ticketNumber: input.ticketNumber,
  });
}

export async function demoteShape(input: {
  shapeKey: string;
  actor: { type: "system" | "admin"; id: string };
  reason: "autonomous_execution_failed" | "manual_revoke";
  ticketId?: string;
  ticketNumber?: number;
}): Promise<{ demoted: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const state = await tx.trustState.findUnique({
            where: { shapeKey: input.shapeKey },
          });
          if (!state) return { demoted: false };

          // Atomic claim — only the caller that still sees "autonomous" proceeds,
          // so concurrent revokes disable the policy and audit exactly once.
          const claimed = await tx.trustState.updateMany({
            where: { shapeKey: input.shapeKey, status: "autonomous" },
            data: { status: "demoted", cleanStreak: 0, streakTicketNumbers: "[]" },
          });
          if (claimed.count !== 1) return { demoted: false };

          if (state.graduatedPolicyId) {
            // Disabled, not deleted — the row stays as history; a re-graduation
            // creates a fresh rule.
            await tx.policy.update({
              where: { id: state.graduatedPolicyId },
              data: { enabled: false },
            });
          }
          await appendAudit(
            {
              actorType: input.actor.type,
              actorId: input.actor.id,
              action: "autonomy.revoked",
              targetType: "shape",
              targetId: input.shapeKey,
              ticketId: input.ticketId,
              detail: {
                reason: input.reason,
                policyId: state.graduatedPolicyId,
                ticketNumber: input.ticketNumber,
              },
            },
            tx,
          );
          return { demoted: true };
        },
        { timeout: 10000 },
      );
    } catch (err) {
      if (isUniqueConflict(err) && attempt < MAX_TX_RETRIES) continue;
      throw err;
    }
  }
}
