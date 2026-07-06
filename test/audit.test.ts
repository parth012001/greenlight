import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, resetDb, auditChainIntact } from "./helpers";
import { requestAction } from "@/lib/actions";

beforeEach(async () => {
  delete process.env.AUDIT_HMAC_KEY;
  await resetDb();
});

afterEach(() => {
  delete process.env.AUDIT_HMAC_KEY;
});

describe("audit hash-chain", () => {
  it("verifies an untampered chain and detects tampering", async () => {
    await requestAction({
      requesterId: "jamie", kind: "grant_access", appId: "airtable",
      level: "read_only", justification: "x",
    });
    expect(await auditChainIntact()).toBe(true);

    // Tamper with one event's payload; the chain must no longer verify.
    const mid = await prisma.auditEvent.findFirstOrThrow({ orderBy: { id: "asc" } });
    await prisma.auditEvent.update({
      where: { id: mid.id },
      data: { detail: JSON.stringify({ hacked: true }) },
    });
    expect(await auditChainIntact()).toBe(false);
  });

  it("an HMAC-keyed chain does not verify without the key", async () => {
    process.env.AUDIT_HMAC_KEY = "test-secret";
    await resetDb(); // reseed writes the chain under the key
    await requestAction({
      requesterId: "jamie", kind: "grant_access", appId: "airtable",
      level: "read_only", justification: "x",
    });
    expect(await auditChainIntact()).toBe(true); // key still set

    process.env.AUDIT_HMAC_KEY = "wrong-key";
    expect(await auditChainIntact()).toBe(false);

    delete process.env.AUDIT_HMAC_KEY;
    expect(await auditChainIntact()).toBe(false);
  });
});
