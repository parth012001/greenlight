import { resolveApproval } from "@/lib/actions";

// Demo stand-in for an authenticated admin session.
const DEMO_ADMIN = "taylor";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { decision, note } = (await req.json()) as {
    decision: "approved" | "denied";
    note?: string;
  };

  if (decision !== "approved" && decision !== "denied") {
    return Response.json({ error: "decision must be approved|denied" }, { status: 400 });
  }

  try {
    const result = await resolveApproval(id, decision, DEMO_ADMIN, note);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "resolve failed" },
      { status: 409 },
    );
  }
}
