import "dotenv/config";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { auditHash } from "../src/lib/audit";

/**
 * Wipe and populate a database with the demo dataset. Exported so the test suite
 * can reset to a known state between tests using the same data the demo runs on.
 */
export async function seed(prisma: PrismaClient) {
  // Wipe in FK-safe order (idempotent re-seed).
  await prisma.graduationProposal.deleteMany();
  await prisma.trustState.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.actionRun.deleteMany();
  await prisma.ticketMessage.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.grant.deleteMany();
  await prisma.policy.deleteMany();
  await prisma.app.deleteMany();
  await prisma.user.deleteMany();
  await prisma.counter.deleteMany();

  await prisma.user.createMany({
    data: [
      { id: "jamie", name: "Jamie Chen", email: "jamie@acme.com", role: "GTM", title: "Sales Operations" },
      { id: "priya", name: "Dr. Priya Patel", email: "priya@acme.com", role: "CLINICAL", title: "Attending Physician" },
      { id: "alex", name: "Alex Rivera", email: "alex@acme.co", role: "CONTRACTOR", title: "Contract Designer" },
      { id: "taylor", name: "Taylor Kim", email: "taylor@acme.com", role: "IT_ADMIN", title: "IT Lead", isAdmin: true },
    ],
  });

  await prisma.app.createMany({
    data: [
      { id: "airtable", name: "Airtable", connectorKey: "okta", levels: "read_only,editor", seatsTotal: 150, seatsUsed: 112 },
      { id: "figma", name: "Figma", connectorKey: "okta", levels: "read_only,editor", seatsTotal: 60, seatsUsed: 41 },
      { id: "salesforce", name: "Salesforce", connectorKey: "okta", levels: "read_only,editor", seatsTotal: 80, seatsUsed: 68 },
      { id: "zoom", name: "Zoom", connectorKey: "workspace", levels: "member", seatsTotal: 200, seatsUsed: 187 },
      { id: "epic-ehr", name: "Epic EHR", connectorKey: "okta", levels: "read_only,clinician", seatsTotal: 40, seatsUsed: 33 },
    ],
  });

  // First-match-wins, ordered. Null = wildcard.
  await prisma.policy.createMany({
    data: [
      {
        id: "contractor-gate", sortOrder: 10, effect: "require_approval",
        name: "Contractors: everything needs approval",
        description: "Any action requested by a contractor is routed to IT, regardless of app or level.",
        role: "CONTRACTOR", kind: null, appId: null, level: null,
      },
      {
        id: "ehr-gate", sortOrder: 20, effect: "require_approval",
        name: "Epic EHR: always human-approved",
        description: "Clinical systems access is never auto-provisioned — HIPAA-sensitive.",
        appId: "epic-ehr", kind: null, level: null, role: null,
      },
      {
        id: "salesforce-gate", sortOrder: 30, effect: "require_approval",
        name: "Salesforce: always human-approved",
        description: "Customer data system; every grant is reviewed.",
        appId: "salesforce", kind: null, level: null, role: null,
      },
      {
        id: "password-auto", sortOrder: 40, effect: "auto_approve",
        name: "Password resets: instant",
        description: "Self-service reset for the authenticated requester; link goes to their verified email.",
        kind: "reset_password", appId: null, level: null, role: null,
      },
      {
        id: "readonly-auto", sortOrder: 50, effect: "auto_approve",
        name: "Read-only access: instant for employees",
        description: "Read-only seats are low-risk and reclaimable; provision immediately.",
        kind: "grant_access", level: "read_only", appId: null, role: null,
      },
      {
        id: "editor-gate", sortOrder: 60, effect: "require_approval",
        name: "Editor access: manager approval",
        description: "Write access to shared tools requires a human sign-off.",
        kind: "grant_access", level: "editor", appId: null, role: null,
      },
      {
        id: "license-auto", sortOrder: 70, effect: "auto_approve",
        name: "Licenses: instant while seats last",
        description: "Provision paid seats automatically; the connector enforces the seat cap.",
        kind: "provision_license", appId: null, level: null, role: null,
      },
    ],
  });

  // Existing access so lookup_requester has something to show.
  await prisma.grant.createMany({
    data: [
      { userId: "jamie", appId: "salesforce", level: "read_only", grantedVia: "onboarding" },
      { userId: "jamie", appId: "zoom", level: "member", grantedVia: "onboarding" },
      { userId: "priya", appId: "epic-ehr", level: "clinician", grantedVia: "onboarding" },
      { userId: "priya", appId: "zoom", level: "member", grantedVia: "onboarding" },
      { userId: "alex", appId: "figma", level: "read_only", grantedVia: "contract-start" },
    ],
  });

  // A little history so the queue isn't empty on first load.
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const t1 = await prisma.ticket.create({
    data: {
      number: 4801, subject: "Dr. Priya Patel · password reset", category: "password",
      status: "solved", requesterId: "priya", createdAt: daysAgo(6),
      messages: { create: { authorType: "system", body: "Password reset link sent to priya@acme.com; active sessions cleared" } },
    },
  });
  const t2 = await prisma.ticket.create({
    data: {
      number: 4802, subject: "Jamie Chen · Zoom license", category: "license",
      status: "solved", requesterId: "jamie", createdAt: daysAgo(5),
      messages: { create: { authorType: "system", body: "Assigned a Zoom license (187/200 seats used)" } },
    },
  });

  // Trust-ledger pre-warm: two APPROVED editor grants for the same shape
  // (grant_access:airtable:editor:GTM) with the full runtime artifact trail —
  // tickets, action runs, approvals, revoked grants, audit events — so the shape
  // sits at 2/3 on first load and ONE live approval triggers the graduation
  // proposal. Every piece mirrors exactly what requestAction/resolveApproval
  // would have written.
  const t3 = await prisma.ticket.create({
    data: {
      number: 4803, subject: "Jamie Chen · editor access to Airtable", category: "access",
      status: "solved", requesterId: "jamie", createdAt: daysAgo(4),
      messages: {
        create: [
          { authorType: "employee", body: "Editing the campaign tracker for the Q2 pipeline review" },
          { authorType: "system", body: "Provisioned editor access to Airtable" },
        ],
      },
    },
  });
  const t4 = await prisma.ticket.create({
    data: {
      number: 4804, subject: "Jamie Chen · editor access to Airtable", category: "access",
      status: "solved", requesterId: "jamie", createdAt: daysAgo(2),
      messages: {
        create: [
          { authorType: "employee", body: "Updating owner fields ahead of the territory hand-off" },
          { authorType: "system", body: "Provisioned editor access to Airtable" },
        ],
      },
    },
  });

  const editorRequest = (justification: string) =>
    JSON.stringify({
      requesterId: "jamie", kind: "grant_access", appId: "airtable",
      level: "editor", justification,
    });
  // idempotencyKey mirrors the runtime key-freeing: only the LATEST terminal run
  // holds the plain key; earlier ones carry the run-id suffix (see requestAction).
  await prisma.actionRun.create({
    data: {
      id: "seed-run-4803", ticketId: t3.id, kind: "grant_access", connectorKey: "okta",
      input: editorRequest("Editing the campaign tracker for the Q2 pipeline review"),
      status: "executed", policyId: "editor-gate",
      idempotencyKey: "jamie:grant_access:airtable:editor:seed-run-4803",
      createdAt: daysAgo(4), executedAt: daysAgo(4),
    },
  });
  await prisma.actionRun.create({
    data: {
      id: "seed-run-4804", ticketId: t4.id, kind: "grant_access", connectorKey: "okta",
      input: editorRequest("Updating owner fields ahead of the territory hand-off"),
      status: "executed", policyId: "editor-gate",
      idempotencyKey: "jamie:grant_access:airtable:editor",
      createdAt: daysAgo(2), executedAt: daysAgo(2),
    },
  });
  await prisma.approval.createMany({
    data: [
      {
        ticketId: t3.id, actionRunId: "seed-run-4803", status: "approved",
        summary: "Jamie Chen (gtm) requests editor access to Airtable",
        decidedBy: "taylor", decidedAt: daysAgo(4), createdAt: daysAgo(4),
      },
      {
        ticketId: t4.id, actionRunId: "seed-run-4804", status: "approved",
        summary: "Jamie Chen (gtm) requests editor access to Airtable",
        decidedBy: "taylor", decidedAt: daysAgo(2), createdAt: daysAgo(2),
      },
    ],
  });
  // Both grants since revoked (projects wrapped), so the live demo genuinely
  // provisions instead of no-oping on an existing grant. Seat count nets zero.
  await prisma.grant.createMany({
    data: [
      { userId: "jamie", appId: "airtable", level: "editor", grantedVia: "greenlight:TKT-4803", createdAt: daysAgo(4), revokedAt: daysAgo(3) },
      { userId: "jamie", appId: "airtable", level: "editor", grantedVia: "greenlight:TKT-4804", createdAt: daysAgo(2), revokedAt: daysAgo(1) },
    ],
  });

  // The ledger tells three stories on first load: a shape one approval from
  // graduating, a shape whose override reset its trust, and a riskier kind
  // with a higher bar.
  await prisma.trustState.createMany({
    data: [
      {
        shapeKey: "grant_access:airtable:editor:GTM",
        kind: "grant_access", appId: "airtable", level: "editor", role: "GTM",
        status: "supervised", threshold: 3, cleanStreak: 2,
        streakTicketNumbers: "[4803,4804]", totalApproved: 2,
      },
      {
        shapeKey: "grant_access:epic-ehr:clinician:CLINICAL",
        kind: "grant_access", appId: "epic-ehr", level: "clinician", role: "CLINICAL",
        status: "supervised", threshold: 3, cleanStreak: 0,
        totalApproved: 1, totalDenied: 1,
      },
      {
        shapeKey: "revoke_access:figma:-:CONTRACTOR",
        kind: "revoke_access", appId: "figma", level: null, role: "CONTRACTOR",
        status: "supervised", threshold: 5, cleanStreak: 0,
        totalDenied: 1,
      },
    ],
  });

  // Ticket-number sequence starts just past the seeded history (4801–4804).
  // Runtime allocation increments this row atomically (see nextTicketNumber).
  await prisma.counter.create({ data: { name: "ticket", value: 4804 } });

  let prevHash = "0".repeat(64);
  const seedEvents = [
    { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: "TKT-4801", ticketId: t1.id, detail: JSON.stringify({ requester: "Dr. Priya Patel", description: "password reset" }) },
    { actorType: "policy", actorId: "password-auto", action: "policy.auto_approve", targetType: "ticket", targetId: "TKT-4801", ticketId: t1.id, detail: JSON.stringify({ rule: "Password resets: instant" }) },
    { actorType: "agent", actorId: "greenlight", action: "action.executed", targetType: "action", targetId: "reset_password", ticketId: t1.id, detail: JSON.stringify({ connector: "Google Workspace (sandbox)", summary: "Password reset link sent" }) },
    { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: "TKT-4802", ticketId: t2.id, detail: JSON.stringify({ requester: "Jamie Chen", description: "Zoom license" }) },
    { actorType: "policy", actorId: "license-auto", action: "policy.auto_approve", targetType: "ticket", targetId: "TKT-4802", ticketId: t2.id, detail: JSON.stringify({ rule: "Licenses: instant while seats last" }) },
    { actorType: "agent", actorId: "greenlight", action: "action.executed", targetType: "action", targetId: "provision_license", ticketId: t2.id, detail: JSON.stringify({ connector: "Google Workspace (sandbox)", summary: "Assigned a Zoom license" }) },
    // The two supervised approvals behind the pre-warmed trust streak — the
    // proposal's evidence tickets resolve to real, chained history.
    { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: "TKT-4803", ticketId: t3.id, detail: JSON.stringify({ requester: "Jamie Chen", description: "editor access to Airtable" }) },
    { actorType: "policy", actorId: "editor-gate", action: "policy.require_approval", targetType: "ticket", targetId: "TKT-4803", ticketId: t3.id, detail: JSON.stringify({ rule: "Editor access: manager approval", role: "GTM" }) },
    { actorType: "agent", actorId: "greenlight", action: "approval.requested", targetType: "ticket", targetId: "TKT-4803", ticketId: t3.id, detail: JSON.stringify({ description: "editor access to Airtable", rule: "Editor access: manager approval" }) },
    { actorType: "admin", actorId: "taylor", action: "approval.granted", targetType: "approval", targetId: "TKT-4803", ticketId: t3.id, detail: JSON.stringify({ summary: "Jamie Chen (gtm) requests editor access to Airtable" }) },
    { actorType: "admin", actorId: "taylor", action: "action.executed", targetType: "action", targetId: "grant_access", ticketId: t3.id, detail: JSON.stringify({ connector: "Okta (sandbox)", summary: "Provisioned editor access to Airtable" }) },
    { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: "TKT-4804", ticketId: t4.id, detail: JSON.stringify({ requester: "Jamie Chen", description: "editor access to Airtable" }) },
    { actorType: "policy", actorId: "editor-gate", action: "policy.require_approval", targetType: "ticket", targetId: "TKT-4804", ticketId: t4.id, detail: JSON.stringify({ rule: "Editor access: manager approval", role: "GTM" }) },
    { actorType: "agent", actorId: "greenlight", action: "approval.requested", targetType: "ticket", targetId: "TKT-4804", ticketId: t4.id, detail: JSON.stringify({ description: "editor access to Airtable", rule: "Editor access: manager approval" }) },
    { actorType: "admin", actorId: "taylor", action: "approval.granted", targetType: "approval", targetId: "TKT-4804", ticketId: t4.id, detail: JSON.stringify({ summary: "Jamie Chen (gtm) requests editor access to Airtable" }) },
    { actorType: "admin", actorId: "taylor", action: "action.executed", targetType: "action", targetId: "grant_access", ticketId: t4.id, detail: JSON.stringify({ connector: "Okta (sandbox)", summary: "Provisioned editor access to Airtable" }) },
  ];
  for (const e of seedEvents) {
    const hash = auditHash(prevHash, e);
    await prisma.auditEvent.create({ data: { ...e, prevHash, hash } });
    prevHash = hash;
  }

  return { users: 4, apps: 5, policies: 7, grants: 7, tickets: 4, trustShapes: 3, auditEvents: seedEvents.length };
}

async function main() {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const n = await seed(prisma);
    console.log(
      `Seeded: ${n.users} users, ${n.apps} apps, ${n.policies} policies, ${n.grants} grants, ${n.tickets} tickets, ${n.trustShapes} trust shapes, ${n.auditEvents} audit events`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Run only when executed directly (prisma db seed / `tsx prisma/seed.ts`), not when
// imported by the test suite.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
