import { prisma } from "@/lib/db";

export async function GET() {
  const policies = await prisma.policy.findMany({ orderBy: { sortOrder: "asc" } });
  return Response.json(policies);
}
