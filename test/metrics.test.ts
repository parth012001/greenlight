import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, resetDb, auditChainIntact } from "./helpers";
import { computeMetrics, MINUTES_SAVED_PER_AUTO, VOLUME_DAYS } from "@/lib/metrics";
import { REPLAY_WINDOW } from "@/lib/graduation";
import { mineSuggestions } from "@/lib/suggestions";
import { requestAction, resolveApproval } from "@/lib/actions";
import { acceptGraduation } from "@/lib/graduation";

// Pin the clock (Date only — timers stay real so async DB calls are unaffected)
// so the seed, which anchors rows to "now", and computeMetrics, which anchors
// the 7-day window to "now", share one instant. Without this, a run that
// straddles UTC midnight drops the oldest seeded day out of the windowed volume
// chart and flakes the exact-sum assertions below. Registered before resetDb so
// the seed itself runs under the pinned clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

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

const today = (m: Awaited<ReturnType<typeof computeMetrics>>) =>
  m.dailyVolume[m.dailyVolume.length - 1];

describe("computeMetrics", () => {
  it("an untouched execution moves auto-resolution; nothing else does", async () => {
    const before = await computeMetrics();

    const r = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "airtable",
      level: "read_only",
      justification: "campaign dashboards",
    });
    expect(r.status).toBe("completed");

    const after = await computeMetrics();
    expect(after.autoResolution.autoResolved).toBe(before.autoResolution.autoResolved + 1);
    expect(after.autoResolution.terminal).toBe(before.autoResolution.terminal + 1);
    expect(after.hoursSaved.hours).toBeCloseTo(
      before.hoursSaved.hours + MINUTES_SAVED_PER_AUTO / 60,
    );
    expect(today(after).auto).toBe(today(before).auto + 1);
  });

  it("a human-approved action grows terminal volume, not auto-resolution", async () => {
    const before = await computeMetrics();
    await approveCycle("jamie", "figma", "editor");
    const after = await computeMetrics();
    expect(after.autoResolution.terminal).toBe(before.autoResolution.terminal + 1);
    expect(after.autoResolution.autoResolved).toBe(before.autoResolution.autoResolved);
    expect(today(after).humanApproved).toBe(today(before).humanApproved + 1);
  });

  it("a denial counts as terminal volume and lands in the day's denied bucket", async () => {
    const before = await computeMetrics();
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

    const after = await computeMetrics();
    expect(after.autoResolution.terminal).toBe(before.autoResolution.terminal + 1);
    expect(after.autoResolution.autoResolved).toBe(before.autoResolution.autoResolved);
    expect(today(after).denied).toBe(today(before).denied + 1);
  });

  it("daily volume always spans the full window, zero-filled, oldest first", async () => {
    const m = await computeMetrics();
    expect(m.dailyVolume).toHaveLength(VOLUME_DAYS);
    const dates = m.dailyVolume.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
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

// The seeded week IS the on-camera dashboard. These numbers are the demo
// script: ~70% auto-resolved, 8 hours back, per-kind coverage that tells the
// policy story at a glance.
describe("the demo numbers: seeded week", () => {
  it("a fresh seed lands at 70% auto-resolved and 8 hours saved", async () => {
    const m = await computeMetrics();
    expect(m.autoResolution.autoResolved).toBe(32);
    expect(m.autoResolution.terminal).toBe(46);
    expect(Math.round(m.autoResolution.rate! * 100)).toBe(70);
    expect(m.hoursSaved.hours).toBe(8);
  });

  it("per-kind coverage tells the policy story", async () => {
    const m = await computeMetrics();
    const byKind = Object.fromEntries(m.autoResolution.byKind.map((k) => [k.kind, k]));
    expect(byKind.reset_password).toMatchObject({ autoResolved: 16, terminal: 16 });
    expect(byKind.grant_access).toMatchObject({ autoResolved: 12, terminal: 24 });
    expect(byKind.provision_license).toMatchObject({ autoResolved: 4, terminal: 6 });
  });

  it("the week's volume is spread across the chart with sane medians", async () => {
    const m = await computeMetrics();
    const sums = m.dailyVolume.reduce(
      (acc, d) => ({
        auto: acc.auto + d.auto,
        humanApproved: acc.humanApproved + d.humanApproved,
        denied: acc.denied + d.denied,
      }),
      { auto: 0, humanApproved: 0, denied: 0 },
    );
    // 32 auto; 10 human-approved (2 bulk + 6 salesforce + TKT-4803/4804); 2
    // denied. Failed and run-less tickets stay out of the chart by design.
    expect(sums).toEqual({ auto: 32, humanApproved: 10, denied: 2 });
    // Day-0 entries are stamped minutes-before-now, so around UTC midnight one
    // bucket can go briefly quiet — the bar chart still reads as a full week.
    const nonEmpty = m.dailyVolume.filter(
      (d) => d.auto + d.humanApproved + d.denied > 0,
    ).length;
    expect(nonEmpty).toBeGreaterThanOrEqual(VOLUME_DAYS - 1);

    // First response is dominated by instant auto-resolutions; approval
    // latency reflects the seeded 9–31 minute human decisions.
    expect(m.latency.medianFirstResponseMs!).toBeGreaterThan(0);
    expect(m.latency.medianFirstResponseMs!).toBeLessThan(5 * 60_000);
    expect(m.latency.medianApprovalMs!).toBeGreaterThan(5 * 60_000);
    expect(m.latency.medianApprovalMs!).toBeLessThan(40 * 60_000);
  });

  it("the seed's terminal volume stays inside the replay window", async () => {
    const terminal = await prisma.actionRun.count({
      where: { status: { in: ["executed", "failed", "denied"] } },
    });
    expect(terminal).toBeLessThanOrEqual(REPLAY_WINDOW);
    expect(terminal).toBe(46); // 38 bulk + 6 salesforce + 2 airtable pre-warm
  });

  it("the bulk history does not confuse the pattern miner", async () => {
    // Two clean CLINICAL approvals sit below threshold; the contractor denial
    // disqualifies its shape; every auto lane is excluded by live policy. The
    // salesforce pattern stays the one and only suggestion.
    const candidates = await mineSuggestions();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].shapeKey).toBe("grant_access:salesforce:read_only:GTM");
    expect(candidates[0].occurrences).toBe(6);
  });
});
