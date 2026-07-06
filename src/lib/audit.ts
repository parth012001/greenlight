import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

// Append-only audit log with a hash chain: each event's hash covers the previous
// event's hash + this event's payload, so any tampering with history breaks the
// chain and is detectable. Audit events are written by the action layer — the UI
// only ever reads them.

export interface AuditInput {
  actorType: "agent" | "admin" | "system" | "policy";
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  ticketId?: string;
  detail?: Record<string, unknown>;
}

const GENESIS_HASH = "0".repeat(64);
const MAX_FORK_RETRIES = 5;

// Single source of truth for the chain hash. seed.ts and scripts/e2e-check.ts
// import this so the write path and every verifier compute identical bytes.
export function auditHash(
  prevHash: string,
  e: {
    actorType: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    detail: string;
  },
): string {
  return createHash("sha256")
    .update(prevHash)
    .update(e.actorType)
    .update(e.actorId)
    .update(e.action)
    .update(e.targetType)
    .update(e.targetId)
    .update(e.detail)
    .digest("hex");
}

// Any client that can run queries — the global client or an interactive-transaction
// client passed in by a caller that owns a wider atomic unit (e.g. requestAction).
type Db = Prisma.TransactionClient | typeof prisma;

async function appendOnce(db: Db, input: AuditInput) {
  const last = await db.auditEvent.findFirst({ orderBy: { id: "desc" } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const detail = JSON.stringify(input.detail ?? {});
  const hash = auditHash(prevHash, { ...input, detail });

  return db.auditEvent.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      ticketId: input.ticketId,
      detail,
      prevHash,
      hash,
    },
  });
}

function isChainForkConflict(err: unknown): boolean {
  // @unique(prevHash) rejects a second event chained off the same tail.
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Append one event to the tail of the chain.
 *
 * The read-tail + insert must be atomic or two concurrent appends compute off the
 * same prevHash and fork the chain (silently breaking verification). We do it inside
 * a transaction and let the @unique(prevHash) constraint reject a fork, retrying on
 * conflict so the loser re-reads the new tail.
 *
 * When a `tx` is supplied, the caller already owns the transaction and its retry
 * loop (e.g. requestAction wraps a whole intent in one tx), so we just chain onto
 * the tail within it.
 */
export async function appendAudit(input: AuditInput, tx?: Prisma.TransactionClient) {
  if (tx) return appendOnce(tx, input);

  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction((t) => appendOnce(t, input));
    } catch (err) {
      if (isChainForkConflict(err) && attempt < MAX_FORK_RETRIES) continue;
      throw err;
    }
  }
}
