import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb, auditChainIntact } from "./helpers";
import { requestAction, resolveApproval } from "@/lib/actions";
import { demoteShape, shapeKeyOf } from "@/lib/trust";

beforeEach(async () => {
  await resetDb();
});

// alex is a CONTRACTOR — contractor-gate routes everything he asks for to a human,
// which makes his shapes the cleanest fixtures for supervised accounting.
const ALEX_KEY = shapeKeyOf({
  kind: "grant_access",
  appId: "figma",
  level: "editor",
  role: "CONTRACTOR",
});

async function alexRequestsFigmaEditor() {
  const r = await requestAction({
    requesterId: "alex",
    kind: "grant_access",
    appId: "figma",
    level: "editor",
    justification: "redesign sprint",
  });
  expect(r.status).toBe("pending_approval");
  return r;
}

async function resolvePending(decision: "approved" | "denied", note?: string) {
  const approval = await prisma.approval.findFirstOrThrow({
    where: { status: "pending" },
  });
  return resolveApproval(approval.id, decision, "taylor", note);
}

// A shape that already earned autonomy: graduated rule + autonomous ledger row.
async function insertGraduatedFixture() {
  await prisma.policy.create({
    data: {
      id: "grad-test",
      name: "Graduated: GTM editor access to Figma",
      description: "test fixture",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      role: "GTM",
      effect: "auto_approve",
      sortOrder: 5,
      enabled: true,
    },
  });
  await prisma.trustState.create({
    data: {
      shapeKey: "grant_access:figma:editor:GTM",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      role: "GTM",
      status: "autonomous",
      threshold: 3,
      totalApproved: 3,
      graduatedPolicyId: "grad-test",
    },
  });
}

async function jamieRequestsFigmaEditor() {
  return requestAction({
    requesterId: "jamie",
    kind: "grant_access",
    appId: "figma",
    level: "editor",
    justification: "campaign mockups",
  });
}

describe("supervised trust accounting", () => {
  it("a clean approval increments the streak and records the evidence ticket", async () => {
    const r = await alexRequestsFigmaEditor();
    await resolvePending("approved");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: ALEX_KEY },
    });
    expect(state.status).toBe("supervised");
    expect(state.cleanStreak).toBe(1);
    expect(state.totalApproved).toBe(1);
    expect(state.threshold).toBe(3);
    expect(JSON.parse(state.streakTicketNumbers)).toEqual([r.ticketNumber]);
  });

  it("a denial resets the streak and counts the override", async () => {
    await alexRequestsFigmaEditor();
    await resolvePending("approved");
    await alexRequestsFigmaEditor();
    await resolvePending("approved");
    await alexRequestsFigmaEditor();
    await resolvePending("denied", "not this quarter");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: ALEX_KEY },
    });
    expect(state.cleanStreak).toBe(0);
    expect(state.totalApproved).toBe(2);
    expect(state.totalDenied).toBe(1);
    expect(state.streakTicketNumbers).toBe("[]");
  });

  it("an approved-but-failed execution counts the approval but interrupts the streak", async () => {
    await alexRequestsFigmaEditor();
    await resolvePending("approved");

    await prisma.app.update({
      where: { id: "figma" },
      data: { simulateFailure: true },
    });
    await alexRequestsFigmaEditor();
    await resolvePending("approved");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: ALEX_KEY },
    });
    expect(state.cleanStreak).toBe(0);
    expect(state.totalApproved).toBe(2);
  });

  it("auto-approved shapes never accumulate trust — they earn nothing from the approval path", async () => {
    const r = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "airtable",
      level: "read_only",
      justification: "view the pipeline",
    });
    expect(r.status).toBe("completed");

    const state = await prisma.trustState.findUnique({
      where: {
        shapeKey: shapeKeyOf({
          kind: "grant_access",
          appId: "airtable",
          level: "read_only",
          role: "GTM",
        }),
      },
    });
    expect(state).toBeNull();
  });
});

describe("autonomous runs + demotion", () => {
  it("a successful autonomous run under a graduated policy increments the run count", async () => {
    await insertGraduatedFixture();
    const r = await jamieRequestsFigmaEditor();
    expect(r.status).toBe("completed");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: "grant_access:figma:editor:GTM" },
    });
    expect(state.autonomousRuns).toBe(1);
    expect(state.status).toBe("autonomous");
  });

  it("a failed autonomous run revokes autonomy: policy disabled, shape demoted, audited", async () => {
    await insertGraduatedFixture();
    await prisma.app.update({
      where: { id: "figma" },
      data: { simulateFailure: true },
    });

    const r = await jamieRequestsFigmaEditor();
    expect(r.status).toBe("failed");

    const policy = await prisma.policy.findUniqueOrThrow({
      where: { id: "grad-test" },
    });
    expect(policy.enabled).toBe(false);

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: "grant_access:figma:editor:GTM" },
    });
    expect(state.status).toBe("demoted");
    expect(state.cleanStreak).toBe(0);
    // graduatedPolicyId stays as history, pointing at the disabled rule.
    expect(state.graduatedPolicyId).toBe("grad-test");

    const revoked = await prisma.auditEvent.findFirst({
      where: { action: "autonomy.revoked" },
    });
    expect(revoked).not.toBeNull();
    expect(revoked!.actorId).toBe("trust-engine");

    // The shape falls back to human review: same ask now routes to approval.
    await prisma.app.update({
      where: { id: "figma" },
      data: { simulateFailure: false },
    });
    const again = await jamieRequestsFigmaEditor();
    expect(again.status).toBe("pending_approval");

    expect(await auditChainIntact()).toBe(true);
  });

  it("manual revoke demotes exactly once", async () => {
    await insertGraduatedFixture();

    const first = await demoteShape({
      shapeKey: "grant_access:figma:editor:GTM",
      actor: { type: "admin", id: "taylor" },
      reason: "manual_revoke",
    });
    expect(first.demoted).toBe(true);

    const second = await demoteShape({
      shapeKey: "grant_access:figma:editor:GTM",
      actor: { type: "admin", id: "taylor" },
      reason: "manual_revoke",
    });
    expect(second.demoted).toBe(false);

    const policy = await prisma.policy.findUniqueOrThrow({
      where: { id: "grad-test" },
    });
    expect(policy.enabled).toBe(false);

    const revocations = await prisma.auditEvent.count({
      where: { action: "autonomy.revoked" },
    });
    expect(revocations).toBe(1);

    expect(await auditChainIntact()).toBe(true);
  });
});
