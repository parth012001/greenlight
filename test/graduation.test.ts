import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb, auditChainIntact } from "./helpers";
import { requestAction, resolveApproval } from "@/lib/actions";
import { acceptGraduation, declineGraduation, type ImpactPreview } from "@/lib/graduation";
import { demoteShape } from "@/lib/trust";
import { evaluatePolicy } from "@/lib/policy";

beforeEach(async () => {
  await resetDb();
});

// The mechanism tests use a shape with NO seeded history (figma editor for GTM),
// so thresholds are exercised from zero. The seed pre-warms airtable editor at
// 2/3 — that shape gets its own demo-arc test below.
const SHAPE_KEY = "grant_access:figma:editor:GTM";
const GRAD_ID = "grad-grant-access-figma-editor-gtm";

async function pendingApprovalFor(ticketNumber: number) {
  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { number: ticketNumber },
  });
  return prisma.approval.findFirstOrThrow({
    where: { ticketId: ticket.id, status: "pending" },
  });
}

// One full supervised loop: request → route to human → approve → execute.
async function approveCycle(requesterId: string, appId: string, level: string) {
  const r = await requestAction({
    requesterId,
    kind: "grant_access",
    appId,
    level,
    justification: "recurring team need",
  });
  expect(r.status).toBe("pending_approval");
  const approval = await pendingApprovalFor(r.ticketNumber!);
  await resolveApproval(approval.id, "approved", "taylor");
  return r.ticketNumber!;
}

async function pendingProposal() {
  return prisma.graduationProposal.findFirstOrThrow({
    where: { status: "pending" },
  });
}

describe("graduation proposals", () => {
  it("three clean approvals propose graduating the shape — exactly once", async () => {
    const tickets = [
      await approveCycle("jamie", "figma", "editor"),
      await approveCycle("jamie", "figma", "editor"),
      await approveCycle("jamie", "figma", "editor"),
    ];

    const proposal = await pendingProposal();
    expect(proposal.shapeKey).toBe(SHAPE_KEY);
    const evidence = JSON.parse(proposal.evidence);
    expect(evidence.streak).toBe(3);
    expect(evidence.ticketNumbers).toEqual(tickets);

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(state.status).toBe("proposed");

    const proposed = await prisma.auditEvent.findFirst({
      where: { action: "graduation.proposed" },
    });
    expect(proposed).not.toBeNull();

    // A fourth clean approval while the proposal is pending must not spawn another.
    await approveCycle("jamie", "figma", "editor");
    expect(
      await prisma.graduationProposal.count({ where: { status: "pending" } }),
    ).toBe(1);
  });

  it("concurrent threshold crossings create a single proposal", async () => {
    // Second GTM user so both requests share the SHAPE but not an idempotency key.
    await prisma.user.create({
      data: {
        id: "morgan",
        name: "Morgan Lee",
        email: "morgan@acme.co",
        role: "GTM",
        title: "Account Executive",
      },
    });
    const shapeKey = "grant_access:salesforce:editor:GTM";
    await prisma.trustState.create({
      data: {
        shapeKey,
        kind: "grant_access",
        appId: "salesforce",
        level: "editor",
        role: "GTM",
        threshold: 3,
        cleanStreak: 2,
        totalApproved: 2,
      },
    });

    const r1 = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "salesforce",
      level: "editor",
      justification: "pipeline edits",
    });
    const r2 = await requestAction({
      requesterId: "morgan",
      kind: "grant_access",
      appId: "salesforce",
      level: "editor",
      justification: "pipeline edits",
    });
    const a1 = await pendingApprovalFor(r1.ticketNumber!);
    const a2 = await pendingApprovalFor(r2.ticketNumber!);

    await Promise.all([
      resolveApproval(a1.id, "approved", "taylor"),
      resolveApproval(a2.id, "approved", "taylor"),
    ]);

    expect(
      await prisma.graduationProposal.count({ where: { shapeKey } }),
    ).toBe(1);
    expect(await auditChainIntact()).toBe(true);
  });

  it("the pre-warmed demo shape proposes after ONE live approval, citing seeded evidence", async () => {
    // Seed leaves grant_access:airtable:editor:GTM at 2/3 with TKT-4803/4804
    // already in the streak — the on-camera arc is a single approval away.
    const live = await approveCycle("jamie", "airtable", "editor");

    const proposal = await pendingProposal();
    expect(proposal.shapeKey).toBe("grant_access:airtable:editor:GTM");
    const evidence = JSON.parse(proposal.evidence);
    expect(evidence.streak).toBe(3);
    expect(evidence.ticketNumbers).toEqual([4803, 4804, live]);
  });

  it("the impact preview replays history: only the target shape flips", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");

    const proposal = await pendingProposal();
    const preview = JSON.parse(proposal.impactPreview) as ImpactPreview;

    expect(preview.diff.before.policyId).toBe("editor-gate");
    expect(preview.diff.before.effect).toBe("require_approval");
    expect(preview.diff.after.insertBeforePolicyId).toBe("editor-gate");
    expect(preview.replay.changed).toBe(3);
    expect(preview.replay.onlyTargetShapeChanges).toBe(true);
    for (const flip of preview.replay.flips) {
      expect(flip.shapeKey).toBe(SHAPE_KEY);
      expect(flip.from).toBe("require_approval");
      expect(flip.to).toBe("auto_approve");
    }
  });
});

describe("accepting a graduation", () => {
  it("inserts the graduated rule before its blocker and flips only the exact shape", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const proposal = await pendingProposal();

    const result = await acceptGraduation(proposal.id, "taylor");
    expect(result).toEqual({ status: "accepted", policyId: GRAD_ID });

    // Placement: before editor-gate, table renumbered back to 10-spacing.
    const policies = await prisma.policy.findMany({
      orderBy: { sortOrder: "asc" },
    });
    const grad = policies.find((p) => p.id === GRAD_ID)!;
    const gate = policies.find((p) => p.id === "editor-gate")!;
    expect(grad.enabled).toBe(true);
    expect(grad.effect).toBe("auto_approve");
    expect(grad.sortOrder).toBeLessThan(gate.sortOrder);
    expect(policies.map((p) => p.sortOrder)).toEqual(
      policies.map((_, i) => (i + 1) * 10),
    );

    // The graduated rule is maximally narrow: only the exact shape flips.
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "figma", level: "editor", role: "GTM" })).policyId,
    ).toBe(GRAD_ID);
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "figma", level: "editor", role: "CONTRACTOR" })).policyId,
    ).toBe("contractor-gate");
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "airtable", level: "editor", role: "GTM" })).policyId,
    ).toBe("editor-gate");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(state.status).toBe("autonomous");
    expect(state.graduatedPolicyId).toBe(GRAD_ID);

    expect(
      await prisma.auditEvent.findFirst({ where: { action: "graduation.accepted" } }),
    ).not.toBeNull();
    expect(
      await prisma.auditEvent.findFirst({ where: { action: "policy.created" } }),
    ).not.toBeNull();

    // Behavior flip, end to end: the same ask now runs without a human.
    const auto = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      justification: "recurring team need",
    });
    expect(auto.status).toBe("completed");
    const after = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(after.autonomousRuns).toBe(1);
  });

  it("a CONTRACTOR shape's graduated rule sorts before the contractor gate", async () => {
    await approveCycle("alex", "figma", "editor");
    await approveCycle("alex", "figma", "editor");
    await approveCycle("alex", "figma", "editor");
    const proposal = await pendingProposal();

    const result = await acceptGraduation(proposal.id, "taylor");
    expect(result.status).toBe("accepted");

    const grad = await prisma.policy.findUniqueOrThrow({
      where: { id: "grad-grant-access-figma-editor-contractor" },
    });
    const gate = await prisma.policy.findUniqueOrThrow({
      where: { id: "contractor-gate" },
    });
    expect(grad.sortOrder).toBeLessThan(gate.sortOrder);

    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "figma", level: "editor", role: "CONTRACTOR" })).policyId,
    ).toBe(grad.id);
    // Everything else the contractor asks for stays gated.
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "airtable", level: "editor", role: "CONTRACTOR" })).policyId,
    ).toBe("contractor-gate");
  });

  it("goes stale instead of applying when the policy environment changed", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const proposal = await pendingProposal();

    // An admin hand-adds an auto rule for the shape while the proposal waits.
    await prisma.policy.create({
      data: {
        id: "manual-auto",
        name: "Manually opened: GTM Figma editor",
        description: "",
        kind: "grant_access",
        appId: "figma",
        level: "editor",
        role: "GTM",
        effect: "auto_approve",
        sortOrder: 1,
        enabled: true,
      },
    });

    const result = await acceptGraduation(proposal.id, "taylor");
    expect(result.status).toBe("stale");

    const updated = await prisma.graduationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(updated.status).toBe("stale");
    expect(
      await prisma.policy.findUnique({ where: { id: GRAD_ID } }),
    ).toBeNull();

    // The evidence wasn't overridden — the environment moved. Streak survives.
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(state.status).toBe("supervised");
    expect(state.cleanStreak).toBe(3);

    expect(
      await prisma.auditEvent.findFirst({ where: { action: "graduation.stale" } }),
    ).not.toBeNull();
  });

  it("a proposal can only be decided once", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const proposal = await pendingProposal();

    await declineGraduation(proposal.id, "taylor", "not yet");
    await expect(declineGraduation(proposal.id, "taylor")).rejects.toThrow(
      /already resolved/,
    );
    await expect(acceptGraduation(proposal.id, "taylor")).rejects.toThrow(
      /already resolved/,
    );
  });
});

describe("losing and re-earning trust", () => {
  it("decline resets the streak; autonomy is re-earned in full", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const first = await pendingProposal();

    await declineGraduation(first.id, "taylor", "one more quarter");
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(state.status).toBe("supervised");
    expect(state.cleanStreak).toBe(0);

    // Re-earn from zero — a fresh streak produces a fresh proposal.
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const second = await pendingProposal();
    expect(second.id).not.toBe(first.id);
    expect(await prisma.graduationProposal.count()).toBe(2);
  });

  it("a denial during review invalidates the pending proposal", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const proposal = await pendingProposal();

    const r = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      justification: "one more seat",
    });
    const approval = await pendingApprovalFor(r.ticketNumber!);
    await resolveApproval(approval.id, "denied", "taylor", "scope creep");

    const updated = await prisma.graduationProposal.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(updated.status).toBe("stale");
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(state.status).toBe("supervised");
    expect(state.cleanStreak).toBe(0);
  });

  it("re-graduation after demotion creates a fresh rule and keeps the old as history", async () => {
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const first = await pendingProposal();
    await acceptGraduation(first.id, "taylor");

    await demoteShape({
      shapeKey: SHAPE_KEY,
      actor: { type: "admin", id: "taylor" },
      reason: "manual_revoke",
    });

    // Back under supervision: the same ask routes to a human again.
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    await approveCycle("jamie", "figma", "editor");
    const second = await pendingProposal();
    const result = await acceptGraduation(second.id, "taylor");
    expect(result).toEqual({ status: "accepted", policyId: `${GRAD_ID}-2` });

    const old = await prisma.policy.findUniqueOrThrow({ where: { id: GRAD_ID } });
    expect(old.enabled).toBe(false);
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SHAPE_KEY },
    });
    expect(state.status).toBe("autonomous");
    expect(state.graduatedPolicyId).toBe(`${GRAD_ID}-2`);

    expect(await auditChainIntact()).toBe(true);
  });
});
