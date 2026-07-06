import { prisma } from "@/lib/db";
import { demoteShape } from "@/lib/trust";
import { getAdminId } from "@/lib/session";

// Body carries the shapeKey (it contains ":", so a path segment would be a
// percent-decoding footgun). Revoking disables the shape's graduated policy —
// a privileged mutation, admin session required.
export async function POST(req: Request) {
  const adminId = await getAdminId();
  if (!adminId) {
    return Response.json({ error: "Admin session required" }, { status: 403 });
  }

  let shapeKey: unknown;
  try {
    ({ shapeKey } = (await req.json()) as { shapeKey?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof shapeKey !== "string" || shapeKey.length === 0) {
    return Response.json({ error: "shapeKey must be a string" }, { status: 400 });
  }

  try {
    const state = await prisma.trustState.findUnique({ where: { shapeKey } });
    if (!state) {
      return Response.json({ error: "Unknown shape" }, { status: 404 });
    }

    const result = await demoteShape({
      shapeKey,
      actor: { type: "admin", id: adminId },
      reason: "manual_revoke",
    });
    if (!result.demoted) {
      return Response.json({ error: "Shape is not autonomous" }, { status: 409 });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Failed to revoke autonomy" }, { status: 500 });
  }
}
