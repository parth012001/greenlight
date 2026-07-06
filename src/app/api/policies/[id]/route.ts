import { prisma } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { getAdminId } from "@/lib/session";
import { Prisma } from "@/generated/prisma/client";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Toggling a policy instantly changes the engine's authorization decisions (disable a
  // gate and sensitive requests fall through to auto_approve) — require an admin session.
  const adminId = await getAdminId();
  if (!adminId) {
    return Response.json({ error: "Admin session required" }, { status: 403 });
  }

  const { id } = await params;

  let enabled: unknown;
  try {
    ({ enabled } = (await req.json()) as { enabled?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  let policy;
  try {
    policy = await prisma.policy.update({ where: { id }, data: { enabled } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return Response.json({ error: "Policy not found" }, { status: 404 });
    }
    throw err;
  }

  await appendAudit({
    actorType: "admin",
    actorId: adminId,
    action: enabled ? "policy.enabled" : "policy.disabled",
    targetType: "policy",
    targetId: policy.id,
    detail: { name: policy.name },
  });
  return Response.json(policy);
}
