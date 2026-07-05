import { prisma } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { evaluatePolicy } from "@/lib/policy";
import { getConnector } from "@/lib/connectors/sandbox";
import type { ActionKind, ConnectorAction } from "@/lib/connectors/types";

// The single gate every consequential action passes through:
//   agent tool → requestAction() → policy check → execute | queue approval | deny
// The model proposes; this layer decides and acts. Approvals resolve through
// resolveApproval() — same connector path, same audit trail.

export interface ActionRequest {
  requesterId: string;
  kind: ActionKind;
  appId?: string;
  level?: string;
  justification: string;
}

export interface ActionOutcome {
  status: "completed" | "pending_approval" | "denied" | "failed";
  ticketNumber: number;
  summary: string;
  policyApplied: string;
  detail?: string;
}

async function nextTicketNumber(): Promise<number> {
  const last = await prisma.ticket.findFirst({ orderBy: { number: "desc" } });
  return (last?.number ?? 4800) + 1;
}

function describeAction(req: ActionRequest, appName?: string): string {
  switch (req.kind) {
    case "grant_access":
      return `${(req.level ?? "").replace("_", "-")} access to ${appName}`;
    case "revoke_access":
      return `revoke access to ${appName}`;
    case "reset_password":
      return "password reset";
    case "provision_license":
      return `${appName} license`;
  }
}

export async function requestAction(req: ActionRequest): Promise<ActionOutcome> {
  const requester = await prisma.user.findUniqueOrThrow({
    where: { id: req.requesterId },
  });
  const app = req.appId
    ? await prisma.app.findUniqueOrThrow({ where: { id: req.appId } })
    : null;
  const description = describeAction(req, app?.name);

  // Idempotency: an identical request with an open or recently-executed action
  // returns the original outcome instead of double-executing. Guards against
  // the model retrying a tool call.
  const idempotencyKey = [req.requesterId, req.kind, req.appId ?? "-", req.level ?? "-"].join(":");
  const existing = await prisma.actionRun.findUnique({
    where: { idempotencyKey },
    include: { ticket: true },
  });
  if (existing && existing.status === "pending_approval") {
    return {
      status: "pending_approval",
      ticketNumber: existing.ticket.number,
      summary: `Already awaiting approval (TKT-${existing.ticket.number}) — no duplicate request created`,
      policyApplied: "idempotency guard",
    };
  }
  if (existing) {
    // Re-requests after a terminal state are legitimate (e.g. denied then policy
    // changed). Free the key by archiving the old run's key.
    await prisma.actionRun.update({
      where: { id: existing.id },
      data: { idempotencyKey: `${idempotencyKey}:${existing.id}` },
    });
  }

  const ticket = await prisma.ticket.create({
    data: {
      number: await nextTicketNumber(),
      subject: `${requester.name} · ${description}`,
      category:
        req.kind === "reset_password"
          ? "password"
          : req.kind === "provision_license"
            ? "license"
            : "access",
      status: "in_progress",
      requesterId: requester.id,
    },
  });
  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      authorType: "employee",
      body: req.justification,
    },
  });
  await appendAudit({
    actorType: "agent",
    actorId: "greenlight",
    action: "ticket.created",
    targetType: "ticket",
    targetId: `TKT-${ticket.number}`,
    ticketId: ticket.id,
    detail: { requester: requester.name, description },
  });

  const decision = await evaluatePolicy({
    kind: req.kind,
    appId: req.appId,
    level: req.level,
    role: requester.role,
  });
  await appendAudit({
    actorType: "policy",
    actorId: decision.policyId ?? "default",
    action: `policy.${decision.effect}`,
    targetType: "ticket",
    targetId: `TKT-${ticket.number}`,
    ticketId: ticket.id,
    detail: { rule: decision.policyName, role: requester.role },
  });

  const connectorKey = app?.connectorKey ?? "workspace";
  const actionRun = await prisma.actionRun.create({
    data: {
      ticketId: ticket.id,
      kind: req.kind,
      connectorKey,
      input: JSON.stringify(req),
      status: "pending_approval",
      policyId: decision.policyId,
      idempotencyKey,
    },
  });

  if (decision.effect === "deny") {
    await prisma.actionRun.update({
      where: { id: actionRun.id },
      data: { status: "denied", result: JSON.stringify({ reason: decision.policyName }) },
    });
    await closeTicket(ticket.id, "denied", `Denied by policy: ${decision.policyName}`);
    return {
      status: "denied",
      ticketNumber: ticket.number,
      summary: `Denied by policy`,
      policyApplied: decision.policyName,
    };
  }

  if (decision.effect === "require_approval") {
    await prisma.approval.create({
      data: {
        ticketId: ticket.id,
        actionRunId: actionRun.id,
        summary: `${requester.name} (${requester.role.toLowerCase()}) requests ${description}`,
      },
    });
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: "pending_approval" },
    });
    await appendAudit({
      actorType: "agent",
      actorId: "greenlight",
      action: "approval.requested",
      targetType: "ticket",
      targetId: `TKT-${ticket.number}`,
      ticketId: ticket.id,
      detail: { description, rule: decision.policyName },
    });
    return {
      status: "pending_approval",
      ticketNumber: ticket.number,
      summary: `Routed to IT for approval per policy`,
      policyApplied: decision.policyName,
    };
  }

  // auto_approve — execute immediately through the connector.
  const outcome = await execute(actionRun.id, "agent", "greenlight");
  return {
    status: outcome.ok ? "completed" : "failed",
    ticketNumber: ticket.number,
    summary: outcome.summary,
    policyApplied: decision.policyName,
    detail: outcome.error,
  };
}

/** Runs the connector for an ActionRun and finalizes ticket + audit state. */
async function execute(
  actionRunId: string,
  actorType: "agent" | "admin",
  actorId: string,
) {
  const run = await prisma.actionRun.findUniqueOrThrow({
    where: { id: actionRunId },
    include: { ticket: true },
  });
  const req = JSON.parse(run.input) as ActionRequest;
  const connector = getConnector(run.connectorKey);

  const connectorAction = {
    kind: run.kind,
    userId: req.requesterId,
    appId: req.appId,
    level: req.level,
  } as ConnectorAction;

  const result = await connector.execute(connectorAction);

  await prisma.actionRun.update({
    where: { id: run.id },
    data: {
      status: result.ok ? "executed" : "failed",
      result: JSON.stringify(result),
      executedAt: new Date(),
    },
  });
  await appendAudit({
    actorType,
    actorId,
    action: result.ok ? "action.executed" : "action.failed",
    targetType: "action",
    targetId: run.kind,
    ticketId: run.ticketId,
    detail: {
      connector: connector.displayName,
      summary: result.summary,
      externalRef: result.externalRef,
      error: result.error,
    },
  });
  await closeTicket(
    run.ticketId,
    result.ok ? "solved" : "in_progress",
    result.ok ? result.summary : `Action failed: ${result.error ?? result.summary}`,
  );
  return result;
}

async function closeTicket(ticketId: string, status: string, note: string) {
  await prisma.ticket.update({ where: { id: ticketId }, data: { status } });
  await prisma.ticketMessage.create({
    data: { ticketId, authorType: "system", body: note },
  });
}

export async function resolveApproval(
  approvalId: string,
  decision: "approved" | "denied",
  deciderId: string,
  note?: string,
) {
  const approval = await prisma.approval.findUniqueOrThrow({
    where: { id: approvalId },
    include: { ticket: true },
  });
  if (approval.status !== "pending") {
    throw new Error(`Approval ${approvalId} already ${approval.status}`);
  }

  await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: decision,
      decidedBy: deciderId,
      deciderNote: note,
      decidedAt: new Date(),
    },
  });
  await appendAudit({
    actorType: "admin",
    actorId: deciderId,
    action: decision === "approved" ? "approval.granted" : "approval.denied",
    targetType: "approval",
    targetId: `TKT-${approval.ticket.number}`,
    ticketId: approval.ticketId,
    detail: { summary: approval.summary, note },
  });

  if (decision === "denied") {
    await prisma.actionRun.update({
      where: { id: approval.actionRunId },
      data: { status: "denied", result: JSON.stringify({ reason: note ?? "denied by approver" }) },
    });
    await closeTicket(
      approval.ticketId,
      "denied",
      `Request denied by IT${note ? `: ${note}` : ""}`,
    );
    return { executed: false };
  }

  const result = await execute(approval.actionRunId, "admin", deciderId);
  return { executed: result.ok, result };
}
