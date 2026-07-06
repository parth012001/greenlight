import { requestAction, resolveApproval } from "../src/lib/actions";
import { prisma } from "../src/lib/db";
import { auditHash } from "../src/lib/audit";

async function main() {
  // 1. Auto-approve path: Jamie (GTM) → Airtable read-only
  const r1 = await requestAction({
    requesterId: "jamie", kind: "grant_access", appId: "airtable",
    level: "read_only", justification: "Need to view the GTM pipeline base",
  });
  console.log("1. jamie/airtable/read_only →", r1.status, "| policy:", r1.policyApplied);

  // 2. Idempotency: same request again should not double-execute
  const r2 = await requestAction({
    requesterId: "jamie", kind: "grant_access", appId: "airtable",
    level: "read_only", justification: "duplicate",
  });
  console.log("2. duplicate request        →", r2.status, "|", r2.summary);

  // 3. Approval-gated path: Alex (CONTRACTOR) → Figma editor
  const r3 = await requestAction({
    requesterId: "alex", kind: "grant_access", appId: "figma",
    level: "editor", justification: "Redesigning the onboarding flow",
  });
  console.log("3. alex/figma/editor        →", r3.status, "| policy:", r3.policyApplied);

  // 4. Admin approves → connector executes
  const approval = await prisma.approval.findFirstOrThrow({ where: { status: "pending" } });
  const r4 = await resolveApproval(approval.id, "approved", "taylor", "contract runs through Q3");
  console.log("4. taylor approves          → executed:", r4.executed);

  // 5. Verify grant landed + audit chain integrity
  const grant = await prisma.grant.findFirst({ where: { userId: "alex", appId: "figma", level: "editor", revokedAt: null } });
  console.log("5. alex figma editor grant  →", grant ? "EXISTS" : "MISSING");

  const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
  let prev = "0".repeat(64); let intact = true;
  for (const e of events) {
    const h = auditHash(prev, e);
    if (h !== e.hash || e.prevHash !== prev) { intact = false; break; }
    prev = e.hash;
  }
  console.log(`6. audit chain (${events.length} events) → ${intact ? "INTACT" : "BROKEN"}`);
}
main().finally(() => prisma.$disconnect());
