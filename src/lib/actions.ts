import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
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

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const MAX_TX_RETRIES = 5;

// Discriminated result of the intent transaction: either we already have the final
// outcome (idempotency short-circuit, deny, or queued approval), or the intent is
// committed and ready to execute through the connector OUTSIDE the transaction.
type Prepared =
  | { kind: "resolved"; outcome: ActionOutcome }
  | { kind: "execute"; actionRunId: string; ticketNumber: number; policyApplied: string };

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Atomic, monotonic ticket-number allocation. `increment` is a single write that
// serializes on the counter row, so concurrent requests never read the same value.
async function nextTicketNumber(tx: Tx): Promise<number> {
  const counter = await tx.counter.update({
    where: { name: "ticket" },
    data: { value: { increment: 1 } },
  });
  return counter.value;
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
  const idempotencyKey = [req.requesterId, req.kind, req.appId ?? "-", req.level ?? "-"].join(":");
  const connectorKey = app?.connectorKey ?? "workspace";

  // Persist the entire intent — ticket, message, audit events, actionRun, and any
  // approval — as ONE atomic unit. Previously these were separate awaits, so a
  // failure partway (a ticket-number collision, an idempotency-key collision, an
  // audit-chain fork) left an orphaned ticket + dangling audit rows. Now it's all
  // or nothing, and we retry on a unique conflict: either a concurrent identical
  // request won the idempotency key, or a concurrent audit append forked the chain —
  // both converge once we re-read state.
  let prepared: Prepared | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      prepared = await prisma.$transaction(
        async (tx): Promise<Prepared> => {
          // Idempotency: an identical request still AWAITING approval returns the
          // original ticket, so the model retrying a tool call can't stack duplicate
          // approval cards. Terminal states (executed/denied/failed) are legitimately
          // re-requestable (denied, then policy changed), so we free the key.
          //
          // This intentionally does NOT dedupe a *completed* action — re-running relies
          // on the connector being idempotent (grant/license no-op when already applied).
          // reset_password is the exception (it re-sends the link); that guarantee lives
          // in the connector, not here.
          const existing = await tx.actionRun.findUnique({
            where: { idempotencyKey },
            include: { ticket: true },
          });
          if (existing && existing.status === "pending_approval") {
            return {
              kind: "resolved",
              outcome: {
                status: "pending_approval",
                ticketNumber: existing.ticket.number,
                summary: `Already awaiting approval (TKT-${existing.ticket.number}) — no duplicate request created`,
                policyApplied: "idempotency guard",
              },
            };
          }
          if (existing) {
            await tx.actionRun.update({
              where: { id: existing.id },
              data: { idempotencyKey: `${idempotencyKey}:${existing.id}` },
            });
          }

          const ticket = await tx.ticket.create({
            data: {
              number: await nextTicketNumber(tx),
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
          await tx.ticketMessage.create({
            data: {
              ticketId: ticket.id,
              authorType: "employee",
              body: req.justification,
            },
          });
          await appendAudit(
            {
              actorType: "agent",
              actorId: "greenlight",
              action: "ticket.created",
              targetType: "ticket",
              targetId: `TKT-${ticket.number}`,
              ticketId: ticket.id,
              detail: { requester: requester.name, description },
            },
            tx,
          );

          const decision = await evaluatePolicy(
            {
              kind: req.kind,
              appId: req.appId,
              level: req.level,
              role: requester.role,
            },
            tx,
          );
          await appendAudit(
            {
              actorType: "policy",
              actorId: decision.policyId ?? "default",
              action: `policy.${decision.effect}`,
              targetType: "ticket",
              targetId: `TKT-${ticket.number}`,
              ticketId: ticket.id,
              detail: { rule: decision.policyName, role: requester.role },
            },
            tx,
          );

          const actionRun = await tx.actionRun.create({
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
            await tx.actionRun.update({
              where: { id: actionRun.id },
              data: { status: "denied", result: JSON.stringify({ reason: decision.policyName }) },
            });
            await closeTicket(tx, ticket.id, "denied", `Denied by policy: ${decision.policyName}`);
            return {
              kind: "resolved",
              outcome: {
                status: "denied",
                ticketNumber: ticket.number,
                summary: `Denied by policy`,
                policyApplied: decision.policyName,
              },
            };
          }

          if (decision.effect === "require_approval") {
            await tx.approval.create({
              data: {
                ticketId: ticket.id,
                actionRunId: actionRun.id,
                summary: `${requester.name} (${requester.role.toLowerCase()}) requests ${description}`,
              },
            });
            await tx.ticket.update({
              where: { id: ticket.id },
              data: { status: "pending_approval" },
            });
            await appendAudit(
              {
                actorType: "agent",
                actorId: "greenlight",
                action: "approval.requested",
                targetType: "ticket",
                targetId: `TKT-${ticket.number}`,
                ticketId: ticket.id,
                detail: { description, rule: decision.policyName },
              },
              tx,
            );
            return {
              kind: "resolved",
              outcome: {
                status: "pending_approval",
                ticketNumber: ticket.number,
                summary: `Routed to IT for approval per policy`,
                policyApplied: decision.policyName,
              },
            };
          }

          // auto_approve — the intent is committed here; the side-effecting connector
          // call runs AFTER commit (it sleeps ~450ms and must not hold the write lock).
          return {
            kind: "execute",
            actionRunId: actionRun.id,
            ticketNumber: ticket.number,
            policyApplied: decision.policyName,
          };
        },
        { timeout: 10000 },
      );
      break;
    } catch (err) {
      if (isUniqueConflict(err) && attempt < MAX_TX_RETRIES) continue;
      throw err;
    }
  }

  if (prepared!.kind === "resolved") return prepared!.outcome;

  const outcome = await execute(prepared!.actionRunId, "agent", "greenlight");
  return {
    status: outcome.ok ? "completed" : "failed",
    ticketNumber: prepared!.ticketNumber,
    summary: outcome.summary,
    policyApplied: prepared!.policyApplied,
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
    prisma,
    run.ticketId,
    result.ok ? "solved" : "in_progress",
    result.ok ? result.summary : `Action failed: ${result.error ?? result.summary}`,
  );
  return result;
}

async function closeTicket(db: Db, ticketId: string, status: string, note: string) {
  await db.ticket.update({ where: { id: ticketId }, data: { status } });
  await db.ticketMessage.create({
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

  // Atomically claim the approval. The check-then-update version was a TOCTOU: two
  // concurrent "approved" POSTs both read status === "pending" and both executed the
  // connector (double grant / double seat / double reset). Here the UPDATE's own
  // WHERE clause is the guard — only the write that still sees "pending" matches a
  // row, so exactly one caller proceeds and the connector runs at most once.
  const claimed = await prisma.approval.updateMany({
    where: { id: approvalId, status: "pending" },
    data: {
      status: decision,
      decidedBy: deciderId,
      deciderNote: note,
      decidedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    throw new Error(`Approval ${approvalId} already resolved`);
  }
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
      prisma,
      approval.ticketId,
      "denied",
      `Request denied by IT${note ? `: ${note}` : ""}`,
    );
    return { executed: false };
  }

  const result = await execute(approval.actionRunId, "admin", deciderId);
  return { executed: result.ok, result };
}
