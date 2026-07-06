import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb, auditChainIntact } from "./helpers";
import {
  mineSuggestions,
  promoteSuggestion,
  MINING_WINDOW_DAYS,
} from "@/lib/suggestions";
import { acceptGraduation, declineGraduation } from "@/lib/graduation";
import { requestAction, resolveApproval } from "@/lib/actions";
import { evaluatePolicy } from "@/lib/policy";

beforeEach(async () => {
  await resetDb();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

// The mechanism tests manufacture history directly (like the seed does) because
// the miner's whole point is history the trust ledger never watched — driving
// the live flow would build streaks and fire the streak engine instead.
const FIGMA_SHAPE = "grant_access:figma:editor:GTM";

let histSeq = 0;
async function insertHistoricalRun(opts: {
  requesterId: string;
  appId: string;
  level: string;
  agedDays: number;
  outcome: "approved" | "denied" | "failed" | "auto";
}) {
  const n = ++histSeq;
  const number = 9000 + n;
  const at = daysAgo(opts.agedDays);
  const ticket = await prisma.ticket.create({
    data: {
      number,
      subject: `history ${number}`,
      category: "access",
      status: opts.outcome === "denied" ? "denied" : "solved",
      requesterId: opts.requesterId,
      createdAt: at,
    },
  });
  const runStatus =
    opts.outcome === "approved" || opts.outcome === "auto"
      ? "executed"
      : opts.outcome; // "denied" | "failed"
  const run = await prisma.actionRun.create({
    data: {
      id: `hist-run-${n}`,
      ticketId: ticket.id,
      kind: "grant_access",
      connectorKey: "okta",
      input: JSON.stringify({
        requesterId: opts.requesterId,
        kind: "grant_access",
        appId: opts.appId,
        level: opts.level,
        justification: "recurring team need",
      }),
      status: runStatus,
      idempotencyKey: `hist:${n}`,
      createdAt: at,
      executedAt: runStatus === "executed" ? at : null,
    },
  });
  if (opts.outcome !== "auto") {
    await prisma.approval.create({
      data: {
        ticketId: ticket.id,
        actionRunId: run.id,
        summary: `history ${number}`,
        // A "failed" run here is human-approved but failed in execution.
        status: opts.outcome === "denied" ? "denied" : "approved",
        decidedBy: "taylor",
        decidedAt: at,
        createdAt: at,
      },
    });
  }
  return number;
}

async function insertCleanFigmaHistory(count: number, newestAgedDays = 1) {
  const tickets: number[] = [];
  for (let i = 0; i < count; i++) {
    tickets.push(
      await insertHistoricalRun({
        requesterId: "jamie",
        appId: "figma",
        level: "editor",
        agedDays: newestAgedDays + (count - 1 - i),
        outcome: "approved",
      }),
    );
  }
  return tickets;
}

describe("mining suggestions", () => {
  it("finds a shape that recurred cleanly and still routes to a human", async () => {
    const tickets = await insertCleanFigmaHistory(3);

    const candidates = await mineSuggestions();
    const figma = candidates.find((c) => c.shapeKey === FIGMA_SHAPE);
    expect(figma).toBeDefined();
    expect(figma!.occurrences).toBe(3);
    expect(figma!.threshold).toBe(3);
    expect(figma!.ticketNumbers).toEqual(tickets);
    expect(figma!.blockedBy.policyId).toBe("editor-gate");
  });

  it("counts only human-approved executions — autonomous runs earn nothing", async () => {
    await insertCleanFigmaHistory(2);
    for (let i = 0; i < 5; i++) {
      await insertHistoricalRun({
        requesterId: "jamie",
        appId: "figma",
        level: "editor",
        agedDays: 1,
        outcome: "auto",
      });
    }

    const candidates = await mineSuggestions();
    expect(candidates.find((c) => c.shapeKey === FIGMA_SHAPE)).toBeUndefined();
  });

  it("a denial in the window disqualifies the shape outright", async () => {
    await insertCleanFigmaHistory(3);
    await insertHistoricalRun({
      requesterId: "jamie",
      appId: "figma",
      level: "editor",
      agedDays: 5,
      outcome: "denied",
    });

    const candidates = await mineSuggestions();
    expect(candidates.find((c) => c.shapeKey === FIGMA_SHAPE)).toBeUndefined();
  });

  it("a failed execution in the window disqualifies the shape", async () => {
    await insertCleanFigmaHistory(3);
    await insertHistoricalRun({
      requesterId: "jamie",
      appId: "figma",
      level: "editor",
      agedDays: 2,
      outcome: "failed",
    });

    const candidates = await mineSuggestions();
    expect(candidates.find((c) => c.shapeKey === FIGMA_SHAPE)).toBeUndefined();
  });

  it("recurrence below the kind's threshold is not a pattern yet", async () => {
    await insertCleanFigmaHistory(2);
    const candidates = await mineSuggestions();
    expect(candidates.find((c) => c.shapeKey === FIGMA_SHAPE)).toBeUndefined();
  });

  it("history outside the mining window is invisible", async () => {
    await insertCleanFigmaHistory(3, MINING_WINDOW_DAYS + 5);
    const candidates = await mineSuggestions();
    expect(candidates.find((c) => c.shapeKey === FIGMA_SHAPE)).toBeUndefined();
  });

  it("shapes that already resolve automatically are never suggested", async () => {
    // Contradictory history (approved runs for an auto shape) exercises the
    // policy filter: read-only airtable auto-approves today, so there is
    // nothing to graduate no matter what history says.
    for (let i = 0; i < 3; i++) {
      await insertHistoricalRun({
        requesterId: "jamie",
        appId: "airtable",
        level: "read_only",
        agedDays: 3 - i,
        outcome: "approved",
      });
    }
    const candidates = await mineSuggestions();
    expect(
      candidates.find((c) => c.shapeKey === "grant_access:airtable:read_only:GTM"),
    ).toBeUndefined();
  });

  it("shapes already proposed or autonomous are excluded; supervised are not", async () => {
    await insertCleanFigmaHistory(3);
    await prisma.trustState.create({
      data: {
        shapeKey: FIGMA_SHAPE,
        kind: "grant_access",
        appId: "figma",
        level: "editor",
        role: "GTM",
        status: "proposed",
        threshold: 3,
      },
    });
    expect(
      (await mineSuggestions()).find((c) => c.shapeKey === FIGMA_SHAPE),
    ).toBeUndefined();

    await prisma.trustState.update({
      where: { shapeKey: FIGMA_SHAPE },
      data: { status: "autonomous" },
    });
    expect(
      (await mineSuggestions()).find((c) => c.shapeKey === FIGMA_SHAPE),
    ).toBeUndefined();

    await prisma.trustState.update({
      where: { shapeKey: FIGMA_SHAPE },
      data: { status: "supervised" },
    });
    expect(
      (await mineSuggestions()).find((c) => c.shapeKey === FIGMA_SHAPE),
    ).toBeDefined();
  });

  it("a pending proposal for the shape suppresses the suggestion", async () => {
    await insertCleanFigmaHistory(3);
    await prisma.graduationProposal.create({
      data: {
        shapeKey: FIGMA_SHAPE,
        kind: "grant_access",
        appId: "figma",
        level: "editor",
        role: "GTM",
        policyName: "Graduated: GTM · editor access to Figma",
        evidence: "{}",
        impactPreview: "{}",
      },
    });
    expect(
      (await mineSuggestions()).find((c) => c.shapeKey === FIGMA_SHAPE),
    ).toBeUndefined();
  });

  it("the seeded airtable pre-warm (2 clean approvals) is below the bar", async () => {
    const candidates = await mineSuggestions();
    expect(
      candidates.find((c) => c.shapeKey === "grant_access:airtable:editor:GTM"),
    ).toBeUndefined();
  });
});

describe("promoting a suggestion", () => {
  it("creates the trust row and a pending proposal through the earned-autonomy lockstep", async () => {
    const tickets = await insertCleanFigmaHistory(4);
    expect(
      await prisma.trustState.findUnique({ where: { shapeKey: FIGMA_SHAPE } }),
    ).toBeNull();

    const result = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    expect(result.status).toBe("promoted");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: FIGMA_SHAPE },
    });
    expect(state.status).toBe("proposed");
    expect(state.threshold).toBe(3);
    expect(state.cleanStreak).toBe(0); // mined evidence lives on the proposal, not the ledger

    const proposal = await prisma.graduationProposal.findUniqueOrThrow({
      where: { id: (result as { proposalId: string }).proposalId },
    });
    expect(proposal.source).toBe("pattern_miner");
    expect(proposal.status).toBe("pending");
    const evidence = JSON.parse(proposal.evidence);
    expect(evidence.streak).toBe(4);
    expect(evidence.ticketNumbers).toEqual(tickets);
    expect(evidence.windowDays).toBe(MINING_WINDOW_DAYS);

    const audited = await prisma.auditEvent.findFirst({
      where: { action: "graduation.proposed" },
    });
    expect(audited).not.toBeNull();
    expect(JSON.parse(audited!.detail).via).toBe("pattern_miner");
    expect(await auditChainIntact()).toBe(true);
  });

  it("promoting twice conflicts instead of double-proposing", async () => {
    await insertCleanFigmaHistory(3);
    const first = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    expect(first.status).toBe("promoted");

    const second = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    expect(second.status).toBe("conflict");
    expect(
      await prisma.graduationProposal.count({ where: { status: "pending" } }),
    ).toBe(1);
  });

  it("promoting a shape that is not a candidate conflicts", async () => {
    const result = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    expect(result.status).toBe("conflict");
    expect(await prisma.graduationProposal.count()).toBe(0);
    expect(
      await prisma.trustState.findUnique({ where: { shapeKey: FIGMA_SHAPE } }),
    ).toBeNull();
  });

  it("accepting a mined proposal creates the rule and the shape runs autonomously", async () => {
    await insertCleanFigmaHistory(3);
    const promoted = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    expect(promoted.status).toBe("promoted");
    const { proposalId } = promoted as { proposalId: string };

    const accepted = await acceptGraduation(proposalId, "taylor");
    expect(accepted.status).toBe("accepted");

    const grad = await prisma.policy.findUniqueOrThrow({
      where: { id: "grad-grant-access-figma-editor-gtm" },
    });
    const gate = await prisma.policy.findUniqueOrThrow({
      where: { id: "editor-gate" },
    });
    expect(grad.sortOrder).toBeLessThan(gate.sortOrder);
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "figma", level: "editor", role: "GTM" })).policyId,
    ).toBe(grad.id);

    // The same ask now completes without a human, and the ledger counts it.
    const auto = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      justification: "recurring team need",
    });
    expect(auto.status).toBe("completed");
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: FIGMA_SHAPE },
    });
    expect(state.status).toBe("autonomous");
    expect(state.autonomousRuns).toBe(1);
    expect(await auditChainIntact()).toBe(true);
  });

  it("declining a mined proposal returns the shape to supervised — and the pattern resurfaces", async () => {
    await insertCleanFigmaHistory(3);
    const promoted = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    await declineGraduation((promoted as { proposalId: string }).proposalId, "taylor", "not yet");

    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: FIGMA_SHAPE },
    });
    expect(state.status).toBe("supervised");
    expect(state.cleanStreak).toBe(0);

    // The evidence still exists, so the candidate reappears. "Not yet" is not
    // "never" — suppression-after-decline is a deliberate non-feature.
    const candidates = await mineSuggestions();
    expect(candidates.find((c) => c.shapeKey === FIGMA_SHAPE)).toBeDefined();
  });

  it("goes stale instead of applying when the policy environment moved after promote", async () => {
    await insertCleanFigmaHistory(3);
    const promoted = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    const { proposalId } = promoted as { proposalId: string };

    // An admin hand-opens the shape while the mined proposal waits.
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

    const result = await acceptGraduation(proposalId, "taylor");
    expect(result.status).toBe("stale");
    expect(
      await prisma.policy.findUnique({
        where: { id: "grad-grant-access-figma-editor-gtm" },
      }),
    ).toBeNull();
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: FIGMA_SHAPE },
    });
    expect(state.status).toBe("supervised");
  });

  it("the streak engine cannot double-propose over a pending mined proposal", async () => {
    await insertCleanFigmaHistory(3);
    await promoteSuggestion(FIGMA_SHAPE, "taylor");

    // Three live clean approvals on the same shape build a real streak, but the
    // TrustState claim (supervised|demoted → proposed) fails while proposed.
    for (let i = 0; i < 3; i++) {
      const r = await requestAction({
        requesterId: "jamie",
        kind: "grant_access",
        appId: "figma",
        level: "editor",
        justification: "recurring team need",
      });
      const ticket = await prisma.ticket.findUniqueOrThrow({
        where: { number: r.ticketNumber! },
      });
      const approval = await prisma.approval.findFirstOrThrow({
        where: { ticketId: ticket.id, status: "pending" },
      });
      await resolveApproval(approval.id, "approved", "taylor");
    }

    expect(
      await prisma.graduationProposal.count({ where: { status: "pending" } }),
    ).toBe(1);
    expect(await auditChainIntact()).toBe(true);
  });

  it("a denial during review stales a mined proposal exactly like an earned one", async () => {
    await insertCleanFigmaHistory(3);
    const promoted = await promoteSuggestion(FIGMA_SHAPE, "taylor");
    const { proposalId } = promoted as { proposalId: string };

    const r = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "figma",
      level: "editor",
      justification: "one more seat",
    });
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { number: r.ticketNumber! },
    });
    const approval = await prisma.approval.findFirstOrThrow({
      where: { ticketId: ticket.id, status: "pending" },
    });
    await resolveApproval(approval.id, "denied", "taylor", "scope creep");

    const proposal = await prisma.graduationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    expect(proposal.status).toBe("stale");
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: FIGMA_SHAPE },
    });
    expect(state.status).toBe("supervised");
    // And the fresh denial now disqualifies the pattern from re-surfacing.
    expect(
      (await mineSuggestions()).find((c) => c.shapeKey === FIGMA_SHAPE),
    ).toBeUndefined();
  });
});

// The seeded demo arc: the miner finds the imported Salesforce pattern, one
// promote + accept flips the shape to autonomous, and the same recurring ask
// completes on camera without a human. These tests ARE the demo script.
describe("the demo arc: the seeded salesforce pattern", () => {
  const SF_SHAPE = "grant_access:salesforce:read_only:GTM";
  const SF_GRAD_ID = "grad-grant-access-salesforce-read-only-gtm";

  it("a fresh seed surfaces exactly one suggestion: the salesforce pattern", async () => {
    const candidates = await mineSuggestions();
    expect(candidates).toHaveLength(1);
    const [c] = candidates;
    expect(c.shapeKey).toBe(SF_SHAPE);
    expect(c.occurrences).toBe(6);
    expect(c.threshold).toBe(3);
    expect(c.ticketNumbers).toEqual([4770, 4771, 4772, 4773, 4774, 4775]);
    expect(c.blockedBy.policyId).toBe("salesforce-gate");
    // The trust ledger has never seen this shape — surfacing it is the miner's job.
    expect(
      await prisma.trustState.findUnique({ where: { shapeKey: SF_SHAPE } }),
    ).toBeNull();
  });

  it("promote → accept → the same ask now runs autonomously (the on-camera beat)", async () => {
    // Before: the shape routes to a human via the salesforce gate.
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "salesforce", level: "read_only", role: "GTM" })).policyId,
    ).toBe("salesforce-gate");

    const promoted = await promoteSuggestion(SF_SHAPE, "taylor");
    expect(promoted.status).toBe("promoted");
    const { proposalId } = promoted as { proposalId: string };
    const proposal = await prisma.graduationProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    expect(proposal.source).toBe("pattern_miner");

    const accepted = await acceptGraduation(proposalId, "taylor");
    expect(accepted).toEqual({ status: "accepted", policyId: SF_GRAD_ID });

    // The graduated rule splices above its blocker; the gate still guards
    // every other salesforce shape, and the other gates are untouched.
    const grad = await prisma.policy.findUniqueOrThrow({ where: { id: SF_GRAD_ID } });
    const gate = await prisma.policy.findUniqueOrThrow({ where: { id: "salesforce-gate" } });
    expect(grad.sortOrder).toBeLessThan(gate.sortOrder);
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "salesforce", level: "read_only", role: "GTM" })).policyId,
    ).toBe(SF_GRAD_ID);
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "salesforce", level: "editor", role: "GTM" })).policyId,
    ).toBe("salesforce-gate");
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "salesforce", level: "read_only", role: "CONTRACTOR" })).policyId,
    ).toBe("contractor-gate");
    expect(
      (await evaluatePolicy({ kind: "grant_access", appId: "epic-ehr", level: "read_only", role: "GTM" })).policyId,
    ).toBe("ehr-gate");

    // Live: the recurring ask completes without a human and genuinely provisions
    // (every prior seat was reclaimed, so this is a real state change).
    const auto = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "salesforce",
      level: "read_only",
      justification: "Pulling the Q2 renewals list",
    });
    expect(auto.status).toBe("completed");
    expect(
      await prisma.grant.findFirst({
        where: { userId: "jamie", appId: "salesforce", level: "read_only", revokedAt: null },
      }),
    ).not.toBeNull();
    const state = await prisma.trustState.findUniqueOrThrow({
      where: { shapeKey: SF_SHAPE },
    });
    expect(state.status).toBe("autonomous");
    expect(state.autonomousRuns).toBe(1);
    expect(await auditChainIntact()).toBe(true);
  });

  it("goes stale if the gate moves between promote and accept", async () => {
    const promoted = await promoteSuggestion(SF_SHAPE, "taylor");
    const { proposalId } = promoted as { proposalId: string };
    // The gate is disabled while the proposal waits — read-only salesforce now
    // falls through to the blanket read-only auto rule; nothing to apply.
    await prisma.policy.update({
      where: { id: "salesforce-gate" },
      data: { enabled: false },
    });
    const result = await acceptGraduation(proposalId, "taylor");
    expect(result.status).toBe("stale");
    expect(await prisma.policy.findUnique({ where: { id: SF_GRAD_ID } })).toBeNull();
  });
});
