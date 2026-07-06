import { prisma } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { getAdminId } from "@/lib/session";
import { Prisma } from "@/generated/prisma/client";

// Sandbox control: flip an app's simulated upstream outage. Exists so the
// demotion path (autonomous run fails → autonomy revoked) is demoable live.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminId = await getAdminId();
  if (!adminId) {
    return Response.json({ error: "Admin session required" }, { status: 403 });
  }

  const { id } = await params;

  let simulateFailure: unknown;
  try {
    ({ simulateFailure } = (await req.json()) as { simulateFailure?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof simulateFailure !== "boolean") {
    return Response.json({ error: "simulateFailure must be a boolean" }, { status: 400 });
  }

  try {
    const app = await prisma.app.update({
      where: { id },
      data: { simulateFailure },
    });
    await appendAudit({
      actorType: "admin",
      actorId: adminId,
      action: simulateFailure ? "app.outage_simulated" : "app.outage_cleared",
      targetType: "app",
      targetId: app.id,
      detail: { name: app.name },
    });
    return Response.json({ ok: true, simulateFailure: app.simulateFailure });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    return Response.json({ error: "Failed to update app" }, { status: 500 });
  }
}
