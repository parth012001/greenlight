import { prisma } from "@/lib/db";
import { seed } from "../prisma/seed";
import { auditHash } from "@/lib/audit";

export { prisma };

/** Reset the test database to the seeded baseline. Call in beforeEach. */
export async function resetDb() {
  await seed(prisma);
}

/** Walk the audit chain and return whether it verifies under the current AUDIT_HMAC_KEY. */
export async function auditChainIntact(): Promise<boolean> {
  const events = await prisma.auditEvent.findMany({ orderBy: { id: "asc" } });
  let prev = "0".repeat(64);
  for (const e of events) {
    if (auditHash(prev, e) !== e.hash || e.prevHash !== prev) return false;
    prev = e.hash;
  }
  return true;
}
