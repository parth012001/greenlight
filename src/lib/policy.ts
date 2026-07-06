import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { ActionKind } from "@/lib/connectors/types";

// Accepts either the global client or an interactive-transaction client, so policy
// can be evaluated inside the same transaction that persists an action's intent.
type Db = Prisma.TransactionClient | typeof prisma;

// Policy is enforced HERE, in the action layer — never by the model. The agent
// can preview policy to set expectations, but nothing executes without passing
// through evaluatePolicy inside requestAction().

export type PolicyEffect = "auto_approve" | "require_approval" | "deny";

export interface PolicyInput {
  kind: ActionKind;
  appId?: string;
  level?: string;
  role: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  policyId: string | null;
  policyName: string;
}

// Default-closed: anything no rule speaks to goes to a human.
const DEFAULT_DECISION: PolicyDecision = {
  effect: "require_approval",
  policyId: null,
  policyName: "Default: unmatched actions require approval",
};

export async function evaluatePolicy(
  input: PolicyInput,
  db: Db = prisma,
): Promise<PolicyDecision> {
  const policies = await db.policy.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });

  for (const p of policies) {
    const matches =
      (p.kind === null || p.kind === input.kind) &&
      (p.appId === null || p.appId === (input.appId ?? null)) &&
      (p.level === null || p.level === (input.level ?? null)) &&
      (p.role === null || p.role === input.role);
    if (matches) {
      return {
        effect: p.effect as PolicyEffect,
        policyId: p.id,
        policyName: p.name,
      };
    }
  }
  return DEFAULT_DECISION;
}
