import "dotenv/config";
import { fileURLToPath } from "node:url";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
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

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  // Existing access so lookup_requester has something to show. Jamie's onboarding
  // Salesforce seat was reclaimed in the quarterly review — which is exactly why
  // she keeps re-requesting it below, and why the live demo genuinely provisions.
  await prisma.grant.createMany({
    data: [
      { userId: "jamie", appId: "salesforce", level: "read_only", grantedVia: "onboarding", createdAt: daysAgo(40), revokedAt: daysAgo(8) },
      { userId: "jamie", appId: "zoom", level: "member", grantedVia: "onboarding" },
      { userId: "priya", appId: "epic-ehr", level: "clinician", grantedVia: "onboarding" },
      { userId: "priya", appId: "zoom", level: "member", grantedVia: "onboarding" },
      { userId: "alex", appId: "figma", level: "read_only", grantedVia: "contract-start" },
    ],
  });

  // A little history so the queue isn't empty on first load. Message timestamps
  // are explicit — they feed the Insights first-response median.
  const t1 = await prisma.ticket.create({
    data: {
      number: 4801, subject: "Dr. Priya Patel · password reset", category: "password",
      status: "solved", requesterId: "priya", createdAt: daysAgo(6),
      messages: { create: { authorType: "system", body: "Password reset link sent to priya@acme.com; active sessions cleared", createdAt: new Date(daysAgo(6).getTime() + 50_000) } },
    },
  });
  const t2 = await prisma.ticket.create({
    data: {
      number: 4802, subject: "Jamie Chen · Zoom license", category: "license",
      status: "solved", requesterId: "jamie", createdAt: daysAgo(5),
      messages: { create: { authorType: "system", body: "Assigned a Zoom license (187/200 seats used)", createdAt: new Date(daysAgo(5).getTime() + 45_000) } },
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
          { authorType: "employee", body: "Editing the campaign tracker for the Q2 pipeline review", createdAt: daysAgo(4) },
          { authorType: "system", body: "Provisioned editor access to Airtable", createdAt: new Date(daysAgo(4).getTime() + 19 * 60_000) },
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
          { authorType: "employee", body: "Updating owner fields ahead of the territory hand-off", createdAt: daysAgo(2) },
          { authorType: "system", body: "Provisioned editor access to Airtable", createdAt: new Date(daysAgo(2).getTime() + 16 * 60_000) },
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
        decidedBy: "taylor", decidedAt: new Date(daysAgo(4).getTime() + 19 * 60_000), createdAt: daysAgo(4),
      },
      {
        ticketId: t4.id, actionRunId: "seed-run-4804", status: "approved",
        summary: "Jamie Chen (gtm) requests editor access to Airtable",
        decidedBy: "taylor", decidedAt: new Date(daysAgo(2).getTime() + 16 * 60_000), createdAt: daysAgo(2),
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

  // Pattern-miner pre-warm: six clean, human-approved read-only Salesforce
  // grants for Jamie — imported history the trust ledger never watched
  // (deliberately NO TrustState row), so the streak engine stays silent and the
  // Suggestions tab discovers the pattern on first load. Salesforce seats are
  // reclaimed after each cycle (every grant below is revoked), which is both why
  // the request keeps recurring and why the live post-accept run genuinely
  // provisions. Every artifact mirrors what requestAction/resolveApproval write.
  const sfJustifications = [
    "Pulling Q1 renewals for the pipeline review",
    "Exporting the account list for territory planning",
    "Checking opportunity stages for the forecast call",
    "Read-only look at the enterprise pipeline for QBR prep",
    "Verifying closed-won accounts for commission reconciliation",
    "Cross-checking contact owners for the hand-off doc",
  ];
  const sfTickets: Array<{ id: string; number: number }> = [];
  for (let i = 0; i < 6; i++) {
    const number = 4770 + i;
    const at = daysAgo(6 - i); // spread daysAgo(6) … daysAgo(1)
    const justification = sfJustifications[i];
    const decidedAt = new Date(at.getTime() + (12 + i * 3) * 60_000); // 12–27 min to a human decision
    const ticket = await prisma.ticket.create({
      data: {
        number, subject: "Jamie Chen · read-only access to Salesforce", category: "access",
        status: "solved", requesterId: "jamie", createdAt: at,
        messages: {
          create: [
            { authorType: "employee", body: justification, createdAt: at },
            { authorType: "system", body: "Provisioned read-only access to Salesforce", createdAt: decidedAt },
          ],
        },
      },
    });
    const runId = `seed-run-${number}`;
    await prisma.actionRun.create({
      data: {
        id: runId, ticketId: ticket.id, kind: "grant_access", connectorKey: "okta",
        input: JSON.stringify({ requesterId: "jamie", kind: "grant_access", appId: "salesforce", level: "read_only", justification }),
        status: "executed", policyId: "salesforce-gate",
        // Latest terminal run holds the plain key; earlier ones carry the suffix.
        idempotencyKey: i === 5 ? "jamie:grant_access:salesforce:read_only" : `jamie:grant_access:salesforce:read_only:${runId}`,
        createdAt: at, executedAt: decidedAt,
      },
    });
    await prisma.approval.create({
      data: {
        ticketId: ticket.id, actionRunId: runId, status: "approved",
        summary: "Jamie Chen (gtm) requests read-only access to Salesforce",
        decidedBy: "taylor", createdAt: at, decidedAt,
      },
    });
    // Seat reclaimed within the day — net zero on the pool, pattern recurs.
    await prisma.grant.create({
      data: {
        userId: "jamie", appId: "salesforce", level: "read_only",
        grantedVia: `greenlight:TKT-${number}`, createdAt: decidedAt,
        revokedAt: new Date(decidedAt.getTime() + 12 * 3_600_000),
      },
    });
    sfTickets.push({ id: ticket.id, number });
  }

  // ---- A week of resolved history for the Insights dashboard -----------------
  // 38 terminal runs, calibrated with the pre-warm history above so a fresh seed
  // lands at 32/46 ≈ 70% auto-resolved (per kind: resets 16/16, grants 12/24,
  // licenses 4/6). Total terminal volume stays deliberately under REPLAY_WINDOW
  // (a test pins the budget) so graduation replay previews see all evidence.
  // No Grant rows for this history — seats long since reclaimed, and the runtime
  // tests rely on fresh provisioning. Idempotency keys all carry the run-id
  // suffix, so no live re-request can collide with a seeded plain key.
  const bulkAt = (agedDays: number, hourUtc: number) => {
    if (agedDays === 0) {
      // Today's entries sit minutes in the past — a fixed hour anchor could
      // land in the future depending on when the seed runs.
      return new Date(Date.now() - (hourUtc * 7 + 5) * 60_000);
    }
    const d = new Date();
    d.setUTCHours(hourUtc, 15 + (hourUtc % 3) * 9, 0, 0);
    d.setUTCDate(d.getUTCDate() - agedDays);
    return d;
  };
  const displayName: Record<string, string> = {
    jamie: "Jamie Chen", priya: "Dr. Priya Patel", alex: "Alex Rivera",
  };

  interface BulkSpec {
    number: number;
    requesterId: string;
    kind: string;
    appId: string | null;
    level: string | null;
    outcome: "auto" | "approved" | "denied" | "failed";
    at: Date;
    subject: string;
    category: string;
    policyId: string;
    policyName: string;
    note: string; // the system/agent message on the ticket
    justification: string | null;
    decideMinutes?: number; // human latency for approved/denied
  }
  const bulk: BulkSpec[] = [];
  let nextBulkNumber = 4720;

  // 16 self-service password resets — the bread-and-butter auto lane.
  for (let i = 0; i < 16; i++) {
    const who = i % 2 === 0 ? "jamie" : "priya";
    bulk.push({
      number: nextBulkNumber++, requesterId: who, kind: "reset_password",
      appId: null, level: null, outcome: "auto", at: bulkAt(6 - (i % 7), 9 + (i % 4)),
      subject: `${displayName[who]} · password reset`, category: "password",
      policyId: "password-auto", policyName: "Password resets: instant",
      note: `Password reset link sent to ${who}@acme.com; active sessions cleared`,
      justification: null,
    });
  }
  // 12 read-only grants across Airtable and Figma — instant for employees.
  for (let i = 0; i < 12; i++) {
    const who = i % 2 === 0 ? "priya" : "jamie";
    const app = i % 2 === 0 ? "figma" : "airtable";
    const appName = app === "figma" ? "Figma" : "Airtable";
    bulk.push({
      number: nextBulkNumber++, requesterId: who, kind: "grant_access",
      appId: app, level: "read_only", outcome: "auto", at: bulkAt(6 - (i % 7), 10 + (i % 5)),
      subject: `${displayName[who]} · read-only access to ${appName}`, category: "access",
      policyId: "readonly-auto", policyName: "Read-only access: instant for employees",
      note: `Provisioned read-only access to ${appName}`,
      justification: `Reviewing the ${appName} workspace for reporting`,
    });
  }
  // 4 Zoom licenses — instant while seats last.
  for (let i = 0; i < 4; i++) {
    const who = i % 2 === 0 ? "jamie" : "priya";
    bulk.push({
      number: nextBulkNumber++, requesterId: who, kind: "provision_license",
      appId: "zoom", level: null, outcome: "auto", at: bulkAt(5 - i, 11 + i),
      subject: `${displayName[who]} · Zoom license`, category: "license",
      policyId: "license-auto", policyName: "Licenses: instant while seats last",
      note: "Assigned a Zoom license", justification: null,
    });
  }
  // 2 human-approved editor grants (CLINICAL — a different shape from every
  // pre-warm, and two clean occurrences keeps the miner deliberately quiet).
  for (let i = 0; i < 2; i++) {
    bulk.push({
      number: nextBulkNumber++, requesterId: "priya", kind: "grant_access",
      appId: "airtable", level: "editor", outcome: "approved", at: bulkAt(4 - i * 2, 10),
      subject: "Dr. Priya Patel · editor access to Airtable", category: "access",
      policyId: "editor-gate", policyName: "Editor access: manager approval",
      note: "Provisioned editor access to Airtable",
      justification: "Maintaining the on-call staffing tracker",
      decideMinutes: 22 + i * 9,
    });
  }
  // 2 denied contractor asks — and a live example of the miner's
  // disqualification rule (a denial in the window bars the shape).
  for (let i = 0; i < 2; i++) {
    bulk.push({
      number: nextBulkNumber++, requesterId: "alex", kind: "grant_access",
      appId: "figma", level: "editor", outcome: "denied", at: bulkAt(5 - i * 3, 13),
      subject: "Alex Rivera · editor access to Figma", category: "access",
      policyId: "contractor-gate", policyName: "Contractors: everything needs approval",
      note: "Denied — outside the current contract scope",
      justification: "Editing handoff files directly",
      decideMinutes: 9 + i * 5,
    });
  }
  // 2 failed license provisions (upstream rejected) — honest failure volume.
  for (let i = 0; i < 2; i++) {
    bulk.push({
      number: nextBulkNumber++, requesterId: "jamie", kind: "provision_license",
      appId: "zoom", level: null, outcome: "failed", at: bulkAt(3 - i * 2, 15),
      subject: "Jamie Chen · Zoom license", category: "license",
      policyId: "license-auto", policyName: "Licenses: instant while seats last",
      note: "Upstream rejected the request for Zoom", justification: null,
    });
  }

  const bulkTickets: Prisma.TicketCreateManyInput[] = [];
  const bulkMessages: Prisma.TicketMessageCreateManyInput[] = [];
  const bulkRuns: Prisma.ActionRunCreateManyInput[] = [];
  const bulkApprovals: Prisma.ApprovalCreateManyInput[] = [];
  for (const s of bulk) {
    const ticketId = `seed-tkt-${s.number}`;
    const runId = `seed-run-${s.number}`;
    const decidedAt = s.decideMinutes
      ? new Date(s.at.getTime() + s.decideMinutes * 60_000)
      : null;
    const resolvedAt = decidedAt ?? new Date(s.at.getTime() + 40_000);
    bulkTickets.push({
      id: ticketId, number: s.number, subject: s.subject, category: s.category,
      status: s.outcome === "denied" ? "denied" : s.outcome === "failed" ? "in_progress" : "solved",
      requesterId: s.requesterId, createdAt: s.at,
    });
    if (s.justification) {
      bulkMessages.push({
        ticketId, authorType: "employee", body: s.justification, createdAt: s.at,
      });
    }
    bulkMessages.push({
      ticketId, authorType: "system", body: s.note, createdAt: resolvedAt,
    });
    bulkRuns.push({
      id: runId, ticketId, kind: s.kind,
      connectorKey: s.kind === "grant_access" ? "okta" : "workspace",
      input: JSON.stringify({
        requesterId: s.requesterId, kind: s.kind,
        ...(s.appId ? { appId: s.appId } : {}),
        ...(s.level ? { level: s.level } : {}),
        ...(s.justification ? { justification: s.justification } : {}),
      }),
      status: s.outcome === "auto" || s.outcome === "approved" ? "executed" : s.outcome,
      result:
        s.outcome === "failed"
          ? JSON.stringify({ ok: false, summary: s.note, error: "upstream_rejected" })
          : null,
      policyId: s.policyId,
      idempotencyKey: `${s.requesterId}:${s.kind}:${s.appId ?? "-"}:${s.level ?? "-"}:${runId}`,
      createdAt: s.at,
      executedAt: s.outcome === "denied" ? null : resolvedAt,
    });
    if (s.outcome === "approved" || s.outcome === "denied") {
      bulkApprovals.push({
        ticketId, actionRunId: runId, status: s.outcome,
        summary: `${displayName[s.requesterId]} (${s.requesterId === "alex" ? "contractor" : s.requesterId === "priya" ? "clinical" : "gtm"}) requests ${s.level ?? ""} access to ${s.appId}`,
        decidedBy: "taylor", createdAt: s.at, decidedAt,
        deciderNote: s.outcome === "denied" ? "outside contract scope" : null,
      });
    }
  }
  await prisma.ticket.createMany({ data: bulkTickets });
  await prisma.ticketMessage.createMany({ data: bulkMessages });
  await prisma.actionRun.createMany({ data: bulkRuns });
  await prisma.approval.createMany({ data: bulkApprovals });

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
  // The mined pattern's paper trail — the suggestion's evidence tickets resolve
  // to real, chained history exactly like the streak pre-warm above.
  for (const t of sfTickets) {
    seedEvents.push(
      { actorType: "agent", actorId: "greenlight", action: "ticket.created", targetType: "ticket", targetId: `TKT-${t.number}`, ticketId: t.id, detail: JSON.stringify({ requester: "Jamie Chen", description: "read-only access to Salesforce" }) },
      { actorType: "policy", actorId: "salesforce-gate", action: "policy.require_approval", targetType: "ticket", targetId: `TKT-${t.number}`, ticketId: t.id, detail: JSON.stringify({ rule: "Salesforce: always human-approved", role: "GTM" }) },
      { actorType: "agent", actorId: "greenlight", action: "approval.requested", targetType: "ticket", targetId: `TKT-${t.number}`, ticketId: t.id, detail: JSON.stringify({ description: "read-only access to Salesforce", rule: "Salesforce: always human-approved" }) },
      { actorType: "admin", actorId: "taylor", action: "approval.granted", targetType: "approval", targetId: `TKT-${t.number}`, ticketId: t.id, detail: JSON.stringify({ summary: "Jamie Chen (gtm) requests read-only access to Salesforce" }) },
      { actorType: "admin", actorId: "taylor", action: "action.executed", targetType: "action", targetId: "grant_access", ticketId: t.id, detail: JSON.stringify({ connector: "Okta (sandbox)", summary: "Provisioned read-only access to Salesforce" }) },
    );
  }
  // Light per-ticket trails for the bulk history — same event vocabulary the
  // runtime writes, condensed to the load-bearing entries.
  for (const s of bulk) {
    const ticketId = `seed-tkt-${s.number}`;
    const target = `TKT-${s.number}`;
    seedEvents.push({
      actorType: "agent", actorId: "greenlight", action: "ticket.created",
      targetType: "ticket", targetId: target, ticketId,
      detail: JSON.stringify({ requester: displayName[s.requesterId], description: s.subject.split(" · ")[1] }),
    });
    if (s.outcome === "auto" || s.outcome === "failed") {
      seedEvents.push(
        {
          actorType: "policy", actorId: s.policyId, action: "policy.auto_approve",
          targetType: "ticket", targetId: target, ticketId,
          detail: JSON.stringify({ rule: s.policyName }),
        },
        {
          actorType: "agent", actorId: "greenlight",
          action: s.outcome === "failed" ? "action.failed" : "action.executed",
          targetType: "action", targetId: s.kind, ticketId,
          detail: JSON.stringify({
            connector: s.kind === "grant_access" ? "Okta (sandbox)" : "Google Workspace (sandbox)",
            summary: s.note,
          }),
        },
      );
    } else {
      seedEvents.push(
        {
          actorType: "policy", actorId: s.policyId, action: "policy.require_approval",
          targetType: "ticket", targetId: target, ticketId,
          detail: JSON.stringify({ rule: s.policyName }),
        },
        {
          actorType: "agent", actorId: "greenlight", action: "approval.requested",
          targetType: "ticket", targetId: target, ticketId,
          detail: JSON.stringify({ description: s.subject.split(" · ")[1], rule: s.policyName }),
        },
        {
          actorType: "admin", actorId: "taylor",
          action: s.outcome === "approved" ? "approval.granted" : "approval.denied",
          targetType: "approval", targetId: target, ticketId,
          detail: JSON.stringify({ summary: s.subject }),
        },
      );
      if (s.outcome === "approved") {
        seedEvents.push({
          actorType: "admin", actorId: "taylor", action: "action.executed",
          targetType: "action", targetId: s.kind, ticketId,
          detail: JSON.stringify({ connector: "Okta (sandbox)", summary: s.note }),
        });
      }
    }
  }
  // Hashes are computed sequentially (the chain is order-defined), then written
  // in one createMany — resetDb() runs before every test, so insert count matters.
  const auditRows: Prisma.AuditEventCreateManyInput[] = [];
  for (const e of seedEvents) {
    const hash = auditHash(prevHash, e);
    auditRows.push({ ...e, prevHash, hash });
    prevHash = hash;
  }
  await prisma.auditEvent.createMany({ data: auditRows });

  return { users: 4, apps: 5, policies: 7, grants: 13, tickets: 48, trustShapes: 3, auditEvents: seedEvents.length };
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
