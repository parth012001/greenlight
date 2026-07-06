import { prisma } from "@/lib/db";
import { safeJsonParse } from "@/lib/json";
import { describeShape, type ActionShape } from "@/lib/shapes";
import type { ActionKind } from "@/lib/connectors/types";

export async function GET() {
  const [states, apps, pending] = await Promise.all([
    prisma.trustState.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.app.findMany({ select: { id: true, name: true } }),
    prisma.graduationProposal.findMany({
      where: { status: "pending" },
      select: { id: true, shapeKey: true },
    }),
  ]);
  const appNames = new Map(apps.map((a) => [a.id, a.name]));
  const proposalByShape = new Map(pending.map((p) => [p.shapeKey, p.id]));

  return Response.json(
    states.map((s) => {
      const shape: ActionShape = {
        kind: s.kind as ActionKind,
        appId: s.appId,
        level: s.level,
        role: s.role,
      };
      return {
        shapeKey: s.shapeKey,
        label: describeShape(shape, s.appId ? appNames.get(s.appId) : undefined),
        kind: s.kind,
        appId: s.appId,
        level: s.level,
        role: s.role,
        status: s.status,
        cleanStreak: s.cleanStreak,
        threshold: s.threshold,
        streakTicketNumbers: safeJsonParse<number[]>(s.streakTicketNumbers, []),
        totalApproved: s.totalApproved,
        totalDenied: s.totalDenied,
        autonomousRuns: s.autonomousRuns,
        graduatedPolicyId: s.graduatedPolicyId,
        pendingProposalId: proposalByShape.get(s.shapeKey) ?? null,
        updatedAt: s.updatedAt,
      };
    }),
  );
}
