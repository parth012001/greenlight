import { resolveApproval } from "@/lib/actions";
import { getAdminId } from "@/lib/session";
import { Prisma } from "@/generated/prisma/client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Approving executes a real, policy-gated connector action — require an admin session.
  const adminId = await getAdminId();
  if (!adminId) {
    return Response.json({ error: "Admin session required" }, { status: 403 });
  }

  const { id } = await params;

  let decision: unknown;
  let note: unknown;
  try {
    ({ decision, note } = (await req.json()) as { decision?: unknown; note?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (decision !== "approved" && decision !== "denied") {
    return Response.json({ error: "decision must be approved|denied" }, { status: 400 });
  }
  if (note !== undefined && typeof note !== "string") {
    return Response.json({ error: "note must be a string" }, { status: 400 });
  }

  try {
    const result = await resolveApproval(id, decision, adminId, note);
    return Response.json(result);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    if (err instanceof Error && /already resolved/.test(err.message)) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json({ error: "Failed to resolve approval" }, { status: 500 });
  }
}
