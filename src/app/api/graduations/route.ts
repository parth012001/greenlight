import { prisma } from "@/lib/db";
import { safeJsonParse } from "@/lib/json";
import { describeShape, type ActionShape } from "@/lib/shapes";
import type { ImpactPreview } from "@/lib/graduation";
import type { ActionKind } from "@/lib/connectors/types";

export async function GET() {
  const [proposals, apps] = await Promise.all([
    prisma.graduationProposal.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.app.findMany({ select: { id: true, name: true } }),
  ]);
  const appNames = new Map(apps.map((a) => [a.id, a.name]));

  return Response.json(
    proposals.map((p) => {
      const shape: ActionShape = {
        kind: p.kind as ActionKind,
        appId: p.appId,
        level: p.level,
        role: p.role,
      };
      return {
        id: p.id,
        shapeKey: p.shapeKey,
        label: describeShape(shape, p.appId ? appNames.get(p.appId) : undefined),
        policyName: p.policyName,
        status: p.status,
        evidence: safeJsonParse<{
          streak?: number;
          threshold?: number;
          ticketNumbers?: number[];
        }>(p.evidence, {}),
        impactPreview: safeJsonParse<ImpactPreview | null>(p.impactPreview, null),
        decidedBy: p.decidedBy,
        deciderNote: p.deciderNote,
        createdAt: p.createdAt,
        decidedAt: p.decidedAt,
      };
    }),
  );
}
