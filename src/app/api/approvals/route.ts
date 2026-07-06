import { prisma } from "@/lib/db";
import { safeJsonParse } from "@/lib/json";

export async function GET() {
  const approvals = await prisma.approval.findMany({
    include: {
      ticket: { include: { requester: { select: { name: true, role: true } } } },
      actionRun: true,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  return Response.json(
    approvals.map((a) => ({
      id: a.id,
      summary: a.summary,
      status: a.status,
      ticketNumber: a.ticket.number,
      requester: a.ticket.requester.name,
      role: a.ticket.requester.role,
      kind: a.actionRun.kind,
      justification: safeJsonParse<{ justification?: string }>(a.actionRun.input, {})
        .justification,
      decidedBy: a.decidedBy,
      deciderNote: a.deciderNote,
      createdAt: a.createdAt,
      decidedAt: a.decidedAt,
    })),
  );
}
