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
  const t1 = await prisma.ticket.create({
    data: {
      number: 4801, subject: "Dr. Priya Patel · password reset", category: "password",
      status: "solved", requesterId: "priya",
      messages: { create: { authorType: "system", body: "Password reset link sent to priya@acme.com; active sessions cleared" } },
    },
  });
  const t2 = await prisma.ticket.create({
    data: {
      number: 4802, subject: "Jamie Chen · Zoom license", category: "license",
      status: "solved", requesterId: "jamie",
      messages: { create: { authorType: "system", body: "Assigned a Zoom license (187/200 seats used)" } },
    },
  });

  // Ticket-number sequence starts just past the seeded history (4801, 4802).
  // Runtime allocation increments this row atomically (see nextTicketNumber).
  await prisma.counter.create({ data: { name: "ticket", value: 4802 } });

  let prevHash = "0".repeat(64);
  const seedEvents = [
    { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: "TKT-4801", ticketId: t1.id, detail: JSON.stringify({ requester: "Dr. Priya Patel", description: "password reset" }) },
    { actorType: "policy", actorId: "password-auto", action: "policy.auto_approve", targetType: "ticket", targetId: "TKT-4801", ticketId: t1.id, detail: JSON.stringify({ rule: "Password resets: instant" }) },
    { actorType: "agent", actorId: "greenlight", action: "action.executed", targetType: "action", targetId: "reset_password", ticketId: t1.id, detail: JSON.stringify({ connector: "Google Workspace (sandbox)", summary: "Password reset link sent" }) },
    { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: "TKT-4802", ticketId: t2.id, detail: JSON.stringify({ requester: "Jamie Chen", description: "Zoom license" }) },
    { actorType: "policy", actorId: "license-auto", action: "policy.auto_approve", targetType: "ticket", targetId: "TKT-4802", ticketId: t2.id, detail: JSON.stringify({ rule: "Licenses: instant while seats last" }) },
    { actorType: "agent", actorId: "greenlight", action: "action.executed", targetType: "action", targetId: "provision_license", ticketId: t2.id, detail: JSON.stringify({ connector: "Google Workspace (sandbox)", summary: "Assigned a Zoom license" }) },
  ];
  for (const e of seedEvents) {
    const hash = auditHash(prevHash, e);
    await prisma.auditEvent.create({ data: { ...e, prevHash, hash } });
    prevHash = hash;
  }

  return { users: 4, apps: 5, policies: 7, grants: 5, tickets: 2, auditEvents: seedEvents.length };
}

async function main() {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const n = await seed(prisma);
    console.log(
      `Seeded: ${n.users} users, ${n.apps} apps, ${n.policies} policies, ${n.grants} grants, ${n.tickets} tickets, ${n.auditEvents} audit events`,
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
