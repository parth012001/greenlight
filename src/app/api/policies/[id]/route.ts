import { prisma } from "@/lib/db";
import { appendAudit } from "@/lib/audit";

const DEMO_ADMIN = "taylor";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { enabled } = (await req.json()) as { enabled: boolean };

  const policy = await prisma.policy.update({
    where: { id },
    data: { enabled },
  });
  await appendAudit({
    actorType: "admin",
    actorId: DEMO_ADMIN,
    action: enabled ? "policy.enabled" : "policy.disabled",
    targetType: "policy",
    targetId: policy.id,
    detail: { name: policy.name },
  });
  return Response.json(policy);
}
