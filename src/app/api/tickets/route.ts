import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requesterId = url.searchParams.get("requesterId") ?? undefined;

  const tickets = await prisma.ticket.findMany({
    where: requesterId ? { requesterId } : undefined,
    include: {
      requester: { select: { name: true, role: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return Response.json(
    tickets.map((t) => ({
      id: t.id,
      number: t.number,
      subject: t.subject,
      category: t.category,
      status: t.status,
      requester: t.requester.name,
      role: t.requester.role,
      lastNote: t.messages[0]?.body ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  );
}
