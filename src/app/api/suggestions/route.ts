import { prisma } from "@/lib/db";
import { mineSuggestions, MINING_WINDOW_DAYS } from "@/lib/suggestions";
import { describeShape } from "@/lib/shapes";

// Read-only: candidates are computed live from history on every poll — nothing
// is persisted until an admin promotes one. The impact preview is deliberately
// NOT built here; it is the decision artifact and is generated at promote time,
// exactly as the streak path generates it at proposal time.
export async function GET() {
  const [candidates, apps] = await Promise.all([
    mineSuggestions(),
    prisma.app.findMany({ select: { id: true, name: true } }),
  ]);
  const appNames = new Map(apps.map((a) => [a.id, a.name]));

  return Response.json(
    candidates.map((c) => ({
      shapeKey: c.shapeKey,
      label: describeShape(
        c.shape,
        c.shape.appId ? appNames.get(c.shape.appId) : undefined,
      ),
      occurrences: c.occurrences,
      threshold: c.threshold,
      ticketNumbers: c.ticketNumbers,
      lastSeenAt: c.lastSeenAt,
      blockedBy: c.blockedBy,
      windowDays: MINING_WINDOW_DAYS,
    })),
  );
}
