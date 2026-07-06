import { acceptGraduation, declineGraduation } from "@/lib/graduation";
import { getAdminId } from "@/lib/session";
import { Prisma } from "@/generated/prisma/client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Accepting rewrites the policy table — the most privileged mutation in the app.
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
  if (decision !== "accepted" && decision !== "declined") {
    return Response.json({ error: "decision must be accepted|declined" }, { status: 400 });
  }
  if (note !== undefined && typeof note !== "string") {
    return Response.json({ error: "note must be a string" }, { status: 400 });
  }

  try {
    if (decision === "accepted") {
      // A stale result is a 200: the client treats it as "refetch and re-read",
      // not an error — the proposal card explains why it died.
      const result = await acceptGraduation(id, adminId, note);
      return Response.json(result);
    }
    await declineGraduation(id, adminId, note);
    return Response.json({ status: "declined" });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return Response.json({ error: "Proposal not found" }, { status: 404 });
    }
    if (err instanceof Error && /already resolved/.test(err.message)) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json({ error: "Failed to resolve proposal" }, { status: 500 });
  }
}
