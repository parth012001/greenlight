import { prisma } from "@/lib/db";

export async function GET() {
  const personas = await prisma.user.findMany({
    where: { isAdmin: false },
    orderBy: { name: "asc" },
  });
  return Response.json(personas);
}
