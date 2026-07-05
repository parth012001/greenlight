import { prisma } from "@/lib/db";
import type { Connector, ConnectorAction, ConnectorResult } from "./types";

// Sandbox connectors behave like production: realistic latency, a failure path
// (App.simulateFailure), and real state mutations — the Grant table is the
// sandbox's system of record. Swapping in a real connector changes nothing
// upstream of the Connector interface.

const SANDBOX_LATENCY_MS = 450;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function failIfConfigured(appId: string): Promise<ConnectorResult | null> {
  const app = await prisma.app.findUnique({ where: { id: appId } });
  if (app?.simulateFailure) {
    return {
      ok: false,
      summary: `Upstream rejected the request for ${app.name}`,
      error: `Sandbox failure injection: ${app.name} returned "insufficient admin privileges". The agent should surface this and escalate — never retry silently.`,
    };
  }
  return null;
}

async function grantAccess(
  via: string,
  userId: string,
  appId: string,
  level: string,
): Promise<ConnectorResult> {
  await sleep(SANDBOX_LATENCY_MS);
  const injected = await failIfConfigured(appId);
  if (injected) return injected;

  const app = await prisma.app.findUniqueOrThrow({ where: { id: appId } });
  const existing = await prisma.grant.findFirst({
    where: { userId, appId, revokedAt: null },
  });

  if (existing && existing.level === level) {
    return {
      ok: true,
      summary: `Already has ${level} access to ${app.name} — no change made`,
      externalRef: existing.id,
    };
  }

  if (existing) {
    // Level change: revoke old grant, issue new one, keep both in history.
    await prisma.grant.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
  } else {
    await prisma.app.update({
      where: { id: appId },
      data: { seatsUsed: { increment: 1 } },
    });
  }

  const grant = await prisma.grant.create({
    data: { userId, appId, level, grantedVia: via },
  });

  return {
    ok: true,
    summary: `Provisioned ${level.replace("_", "-")} access to ${app.name}`,
    externalRef: grant.id,
  };
}

async function revokeAccess(userId: string, appId: string): Promise<ConnectorResult> {
  await sleep(SANDBOX_LATENCY_MS);
  const app = await prisma.app.findUniqueOrThrow({ where: { id: appId } });
  const existing = await prisma.grant.findFirst({
    where: { userId, appId, revokedAt: null },
  });
  if (!existing) {
    return { ok: true, summary: `No active ${app.name} access to revoke` };
  }
  await prisma.grant.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
  await prisma.app.update({
    where: { id: appId },
    data: { seatsUsed: { decrement: 1 } },
  });
  return { ok: true, summary: `Revoked ${app.name} access`, externalRef: existing.id };
}

async function resetPassword(userId: string): Promise<ConnectorResult> {
  await sleep(SANDBOX_LATENCY_MS);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    ok: true,
    summary: `Password reset link sent to ${user.email}; active sessions cleared`,
    externalRef: `pwreset_${userId}_${Date.now()}`,
  };
}

async function provisionLicense(
  via: string,
  userId: string,
  appId: string,
): Promise<ConnectorResult> {
  await sleep(SANDBOX_LATENCY_MS);
  const injected = await failIfConfigured(appId);
  if (injected) return injected;

  const app = await prisma.app.findUniqueOrThrow({ where: { id: appId } });
  if (app.seatsUsed >= app.seatsTotal) {
    return {
      ok: false,
      summary: `No ${app.name} seats available (${app.seatsUsed}/${app.seatsTotal})`,
      error: "seat_limit_reached",
    };
  }
  const existing = await prisma.grant.findFirst({
    where: { userId, appId, revokedAt: null },
  });
  if (existing) {
    return { ok: true, summary: `Already licensed for ${app.name} — no change made` };
  }
  await prisma.app.update({
    where: { id: appId },
    data: { seatsUsed: { increment: 1 } },
  });
  const grant = await prisma.grant.create({
    data: { userId, appId, level: "member", grantedVia: via },
  });
  return {
    ok: true,
    summary: `Assigned a ${app.name} license (${app.seatsUsed + 1}/${app.seatsTotal} seats used)`,
    externalRef: grant.id,
  };
}

function makeSandboxConnector(key: string, displayName: string): Connector {
  return {
    key,
    displayName,
    async execute(action: ConnectorAction): Promise<ConnectorResult> {
      const via = "greenlight-sandbox";
      switch (action.kind) {
        case "grant_access":
          return grantAccess(via, action.userId, action.appId, action.level);
        case "revoke_access":
          return revokeAccess(action.userId, action.appId);
        case "reset_password":
          return resetPassword(action.userId);
        case "provision_license":
          return provisionLicense(via, action.userId, action.appId);
      }
    },
  };
}

export const sandboxOkta = makeSandboxConnector("okta", "Okta (sandbox)");
export const sandboxWorkspace = makeSandboxConnector(
  "workspace",
  "Google Workspace (sandbox)",
);

const registry: Record<string, Connector> = {
  [sandboxOkta.key]: sandboxOkta,
  [sandboxWorkspace.key]: sandboxWorkspace,
};

export function getConnector(key: string): Connector {
  const connector = registry[key];
  if (!connector) throw new Error(`No connector registered for key "${key}"`);
  return connector;
}
