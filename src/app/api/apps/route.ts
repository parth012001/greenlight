import { prisma } from "@/lib/db";

export async function GET() {
  const apps = await prisma.app.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      connectorKey: true,
      seatsTotal: true,
      seatsUsed: true,
      simulateFailure: true,
    },
  });
  return Response.json(apps);
}
