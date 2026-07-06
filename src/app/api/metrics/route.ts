import { computeMetrics } from "@/lib/metrics";

// Read-only aggregation, same unguarded-GET convention as the other console reads.
export async function GET() {
  return Response.json(await computeMetrics());
}
