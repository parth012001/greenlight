import { promoteSuggestion } from "@/lib/suggestions";
import { getAdminId } from "@/lib/session";

// Body carries the shapeKey (it contains ":", so a path segment would be a
// percent-decoding footgun — same reasoning as trust/revoke). Promoting drafts
// a graduation proposal — a privileged mutation, admin session required.
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
    const result = await promoteSuggestion(shapeKey, adminId);
    if (result.status === "conflict") {
      return Response.json({ error: result.reason }, { status: 409 });
    }
    return Response.json(result);
  } catch {
    return Response.json({ error: "Failed to promote suggestion" }, { status: 500 });
  }
}
