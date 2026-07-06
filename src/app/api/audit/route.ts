import { prisma } from "@/lib/db";
import { safeJsonParse } from "@/lib/json";

export async function GET() {
  const events = await prisma.auditEvent.findMany({
    orderBy: { id: "desc" },
    take: 100,
  });
  return Response.json(
    events.map((e) => ({
      id: e.id,
      ts: e.ts,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      target: e.targetId,
      detail: safeJsonParse<Record<string, unknown>>(e.detail, {}),
      hash: e.hash,
      prevHash: e.prevHash,
    })),
  );
}
