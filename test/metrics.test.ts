import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb, auditChainIntact } from "./helpers";
import { computeMetrics, MINUTES_SAVED_PER_AUTO, VOLUME_DAYS } from "@/lib/metrics";
import { requestAction, resolveApproval } from "@/lib/actions";
import { acceptGraduation } from "@/lib/graduation";

beforeEach(async () => {
  await resetDb();
});

async function approveCycle(requesterId: string, appId: string, level: string) {
  const r = await requestAction({
    requesterId,
    kind: "grant_access",
    appId,
    level,
    justification: "recurring team need",
  });
  expect(r.status).toBe("pending_approval");
  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { number: r.ticketNumber! },
  });
  const approval = await prisma.approval.findFirstOrThrow({
    where: { ticketId: ticket.id, status: "pending" },
  });
  await resolveApproval(approval.id, "approved", "taylor");
  return r.ticketNumber!;
}

describe("computeMetrics", () => {
  it("counts only untouched executions as auto-resolved", async () => {
    // The seed's terminal history is entirely human-approved (2 airtable + 6
    // salesforce) — the auto-resolution numerator starts at zero.
    const before = await computeMetrics();
    expect(before.autoResolution.terminal).toBe(8);
    expect(before.autoResolution.autoResolved).toBe(0);
    expect(before.autoResolution.rate).toBe(0);
    expect(before.hoursSaved.hours).toBe(0);

    // One auto-approved action (read-only is instant for employees) ticks it.
    const r = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "airtable",
      level: "read_only",
      justification: "campaign dashboards",
    });
    expect(r.status).toBe("completed");

    const after = await computeMetrics();
    expect(after.autoResolution.terminal).toBe(9);
    expect(after.autoResolution.autoResolved).toBe(1);
    expect(after.autoResolution.rate).toBeCloseTo(1 / 9);
    expect(after.hoursSaved.hours).toBeCloseTo(MINUTES_SAVED_PER_AUTO / 60);

    const grants = after.autoResolution.byKind.find((k) => k.kind === "grant_access")!;
    expect(grants.autoResolved).toBe(1);
    expect(grants.terminal).toBe(9);
  });

  it("a human-approved action grows terminal volume, not auto-resolution", async () => {
    await approveCycle("jamie", "figma", "editor");
    const m = await computeMetrics();
    expect(m.autoResolution.terminal).toBe(9);
    expect(m.autoResolution.autoResolved).toBe(0);
  });

  it("a denial counts as terminal volume and lands in the day's denied bucket", async () => {
    const r = await requestAction({
      requesterId: "alex",
      kind: "grant_access",
      appId: "airtable",
      level: "editor",
      justification: "client mockups",
    });
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { number: r.ticketNumber! },
    });
    const approval = await prisma.approval.findFirstOrThrow({
      where: { ticketId: ticket.id, status: "pending" },
    });
    await resolveApproval(approval.id, "denied", "taylor", "contract scope");

    const m = await computeMetrics();
    expect(m.autoResolution.terminal).toBe(9);
    expect(m.autoResolution.autoResolved).toBe(0);
    const today = m.dailyVolume[m.dailyVolume.length - 1];
    expect(today.denied).toBe(1);
  });

  it("latency medians are computed from real timestamps", async () => {
    const m = await computeMetrics();
    // Seeded salesforce approvals carry explicit 12–27 minute decide latencies.
    expect(m.latency.medianApprovalMs).not.toBeNull();
    expect(m.latency.medianApprovalMs!).toBeGreaterThanOrEqual(0);
    expect(m.latency.medianFirstResponseMs).not.toBeNull();
    expect(m.latency.medianFirstResponseMs!).toBeGreaterThanOrEqual(0);
  });

  it("daily volume always spans the full window, zero-filled, oldest first", async () => {
    const m = await computeMetrics();
    expect(m.dailyVolume).toHaveLength(VOLUME_DAYS);
    const dates = m.dailyVolume.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);

    // A live auto action lands in today's bucket immediately.
    await requestAction({
      requesterId: "priya",
      kind: "reset_password",
      justification: "locked out",
    });
    const after = await computeMetrics();
    const today = after.dailyVolume[after.dailyVolume.length - 1];
    expect(today.auto).toBe(1);
  });

  it("autonomous success tracks graduated-rule runs only — and an outage drops it", async () => {
    // No graduated rules yet: the metric is honest about having no data.
    expect((await computeMetrics()).autonomous.successRate).toBeNull();

    // Earn autonomy for figma editor GTM through the real flow, so the
    // policy.created{via:graduation} audit event registers the rule.
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const proposal = await prisma.graduationProposal.findFirstOrThrow({
      where: { status: "pending" },
    });
    await acceptGraduation(proposal.id, "taylor");

    // The human-approved cycles above never count as autonomous runs.
    expect((await computeMetrics()).autonomous).toEqual({
      executed: 0,
      failed: 0,
      successRate: null,
    });

    const auto = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      justification: "recurring team need",
    });
    expect(auto.status).toBe("completed");
    expect((await computeMetrics()).autonomous).toEqual({
      executed: 1,
      failed: 0,
      successRate: 1,
    });

    // Outage: the same autonomous ask fails, the success rate halves on the
    // spot, and the existing demotion path revokes the shape's autonomy.
    await prisma.app.update({
      where: { id: "figma" },
      data: { simulateFailure: true },
    });
    const failed = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      justification: "recurring team need",
    });
    expect(failed.status).toBe("failed");

    const m = await computeMetrics();
    expect(m.autonomous).toEqual({ executed: 1, failed: 1, successRate: 0.5 });
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: "grant_access:figma:editor:GTM" },
    });
    expect(state.status).toBe("demoted");
    expect(await auditChainIntact()).toBe(true);
  });
});
