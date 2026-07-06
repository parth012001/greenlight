import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "./helpers";
import { requestAction, resolveApproval } from "@/lib/actions";

beforeEach(async () => {
  await resetDb();
});

describe("policy enforcement", () => {
  it("defaults closed: an action no rule matches requires approval", async () => {
    // No seeded policy speaks to revoke_access, so it must fall through to default.
    const r = await requestAction({
      requesterId: "jamie",
      kind: "revoke_access",
      appId: "airtable",
      justification: "no longer need it",
    });
    expect(r.status).toBe("pending_approval");
    expect(r.policyApplied).toMatch(/Default/);
  });

  it("auto-approves a read-only grant and executes it", async () => {
    const r = await requestAction({
      requesterId: "jamie",
      kind: "grant_access",
      appId: "airtable",
      level: "read_only",
      justification: "view the pipeline",
    });
    expect(r.status).toBe("completed");
    const grant = await prisma.grant.findFirst({
      where: { userId: "jamie", appId: "airtable", level: "read_only", revokedAt: null },
    });
    expect(grant).not.toBeNull();
  });

  it("deny closes the ticket and executes nothing", async () => {
    await prisma.policy.create({
      data: {
        id: "deny-test", name: "deny contractor grants", description: "",
        kind: "grant_access", role: "CONTRACTOR", effect: "deny", sortOrder: 1, enabled: true,
      },
    });
    const r = await requestAction({
      requesterId: "alex", kind: "grant_access", appId: "figma",
      level: "editor", justification: "redesign",
    });
    expect(r.status).toBe("denied");
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { number: r.ticketNumber } });
    expect(ticket.status).toBe("denied");
    const grant = await prisma.grant.findFirst({
      where: { userId: "alex", appId: "figma", level: "editor", revokedAt: null },
    });
    expect(grant).toBeNull();
  });
});

describe("LLM trust boundary", () => {
  it("rejects a level the app does not offer, without creating a ticket", async () => {
    const before = await prisma.ticket.count();
    const r = await requestAction({
      requesterId: "jamie", kind: "grant_access", appId: "airtable",
      level: "superadmin", justification: "nice try",
    });
    expect(r.status).toBe("denied");
    expect(r.policyApplied).toBe("input validation");
    expect(r.ticketNumber).toBeUndefined();
    expect(await prisma.ticket.count()).toBe(before);
  });

  it("rejects an unknown appId cleanly", async () => {
    const r = await requestAction({
      requesterId: "jamie", kind: "grant_access", appId: "not-a-real-app",
      level: "read_only", justification: "x",
    });
    expect(r.status).toBe("denied");
    expect(r.policyApplied).toBe("input validation");
  });
});

describe("connector failure", () => {
  it("surfaces an upstream failure without mutating grants", async () => {
    await prisma.app.update({ where: { id: "airtable" }, data: { simulateFailure: true } });
    const r = await requestAction({
      requesterId: "jamie", kind: "grant_access", appId: "airtable",
      level: "read_only", justification: "x",
    });
    expect(r.status).toBe("failed");
    const grant = await prisma.grant.findFirst({
      where: { userId: "jamie", appId: "airtable", revokedAt: null },
    });
    expect(grant).toBeNull();
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { number: r.ticketNumber } });
    expect(ticket.status).toBe("in_progress");
  });
});

describe("idempotency + approval", () => {
  it("dedupes an identical request that is still pending approval", async () => {
    const a = await requestAction({
      requesterId: "alex", kind: "grant_access", appId: "figma",
      level: "editor", justification: "first",
    });
    expect(a.status).toBe("pending_approval");
    const b = await requestAction({
      requesterId: "alex", kind: "grant_access", appId: "figma",
      level: "editor", justification: "second",
    });
    expect(b.ticketNumber).toBe(a.ticketNumber);
    expect(b.policyApplied).toBe("idempotency guard");
    expect(await prisma.approval.count({ where: { status: "pending" } })).toBe(1);
  });

  it("approving executes the connector; a second resolve is rejected", async () => {
    await requestAction({
      requesterId: "alex", kind: "grant_access", appId: "figma",
      level: "editor", justification: "x",
    });
    const approval = await prisma.approval.findFirstOrThrow({ where: { status: "pending" } });
    const first = await resolveApproval(approval.id, "approved", "taylor");
    expect(first.executed).toBe(true);
    const grant = await prisma.grant.findFirst({
      where: { userId: "alex", appId: "figma", level: "editor", revokedAt: null },
    });
    expect(grant).not.toBeNull();
    await expect(resolveApproval(approval.id, "approved", "taylor")).rejects.toThrow(/already resolved/);
  });

  it("denying at approval closes the ticket and runs no connector", async () => {
    await requestAction({
      requesterId: "alex", kind: "grant_access", appId: "figma",
      level: "editor", justification: "x",
    });
    const approval = await prisma.approval.findFirstOrThrow({ where: { status: "pending" } });
    const res = await resolveApproval(approval.id, "denied", "taylor", "not this quarter");
    expect(res.executed).toBe(false);
    const grant = await prisma.grant.findFirst({
      where: { userId: "alex", appId: "figma", level: "editor", revokedAt: null },
    });
    expect(grant).toBeNull();
  });
});
