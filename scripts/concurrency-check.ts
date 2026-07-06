// Concurrency harness: proves the action layer stays consistent under overlapping
// requests. On SQLite (single writer) most races are masked, so the value here is
// (a) confirming the interactive-transaction code doesn't deadlock/SQLITE_BUSY on the
// better-sqlite3 adapter, and (b) asserting the invariants that the unique constraints
// and atomic guards enforce. Run against a freshly seeded db:  npx tsx prisma/seed.ts
import "dotenv/config";
import { requestAction, resolveApproval } from "../src/lib/actions";
import { prisma } from "../src/lib/db";
import { auditHash } from "../src/lib/audit";

async function chainIntact(): Promise<boolean> {
  const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
  let prev = "0".repeat(64);
  for (const e of events) {
    if (auditHash(prev, e) !== e.hash || e.prevHash !== prev) return false;
    prev = e.hash;
  }
  return true;
}

const errStr = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function main() {
  const N = 8;
  let pass = true;
  const check = (label: string, ok: boolean, detail = "") => {
    pass &&= ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  // 1. Concurrent identical auto-approve requests: no crash, exactly one active grant.
  const r1 = await Promise.all(
    Array.from({ length: N }, () =>
      requestAction({
        requesterId: "jamie", kind: "grant_access", appId: "airtable",
        level: "read_only", justification: "concurrent",
      }).then(() => null).catch(errStr),
    ),
  );
  const e1 = r1.filter(Boolean);
  check(`${N}x identical auto-approve: no unhandled errors`, e1.length === 0, e1[0] as string);
  const activeAirtable = await prisma.grant.count({
    where: { userId: "jamie", appId: "airtable", revokedAt: null },
  });
  check("exactly one active jamie/airtable grant", activeAirtable === 1, `got ${activeAirtable}`);

  // 2. Concurrent IDENTICAL approval-gated requests dedupe to a single approval —
  //    the idempotency guard must not stack duplicate approval cards under a race.
  const r2 = await Promise.all(
    Array.from({ length: N }, () =>
      requestAction({
        requesterId: "alex", kind: "grant_access", appId: "figma",
        level: "editor", justification: "concurrent",
      }).then((o) => o.ticketNumber).catch(errStr),
    ),
  );
  const e2 = r2.filter((r) => typeof r === "string");
  check(`${N}x identical contractor requests: no unhandled errors`, e2.length === 0, e2[0] as string);
  const nums = r2.filter((r) => typeof r === "number") as number[];
  check("identical requests dedupe to one ticket", new Set(nums).size === 1,
    `${new Set(nums).size} distinct tickets`);
  const pendingForAlex = await prisma.approval.count({
    where: { status: "pending", ticket: { requesterId: "alex" } },
  });
  check("exactly one pending approval created", pendingForAlex === 1, `got ${pendingForAlex}`);

  // 3. Audit chain still verifies after all that concurrency.
  check("audit chain intact under concurrency", await chainIntact());

  // 4. Double-resolve the same approval concurrently: connector executes exactly once.
  const appr = await prisma.approval.findFirst({ where: { status: "pending" } });
  if (appr) {
    const dbl = await Promise.allSettled([
      resolveApproval(appr.id, "approved", "taylor"),
      resolveApproval(appr.id, "approved", "taylor"),
    ]);
    const executed = dbl.filter(
      (d) => d.status === "fulfilled" && (d.value as { executed: boolean }).executed,
    ).length;
    check("concurrent double-resolve executes exactly once", executed === 1, `executed=${executed}`);
  }

  console.log(pass ? "\nALL CONCURRENCY CHECKS PASSED" : "\nSOME CHECKS FAILED");
  if (!pass) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
