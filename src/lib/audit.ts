import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";

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

export async function appendAudit(input: AuditInput) {
  const last = await prisma.auditEvent.findFirst({ orderBy: { id: "desc" } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const detail = JSON.stringify(input.detail ?? {});

  const hash = createHash("sha256")
    .update(prevHash)
    .update(input.actorType)
    .update(input.actorId)
    .update(input.action)
    .update(input.targetType)
    .update(input.targetId)
    .update(detail)
    .digest("hex");

  return prisma.auditEvent.create({
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
