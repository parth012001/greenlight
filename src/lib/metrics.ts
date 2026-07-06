import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { safeJsonParse } from "@/lib/json";

// Read-only aggregation over the tables the action layer already writes — no
// new write path, no migration. The formulas are the ITSM-standard ones:
// auto-resolution rate (terminal actions that ran with no human touch), hours
// saved (auto-resolved count × a per-action minutes constant, displayed as an
// explicit assumption), autonomous success rate (graduated-rule runs only),
// and latency medians. Everything is computed in memory: the dataset is demo
// scale, and it keeps this consistent with the replay engine's idiom.

type Db = Prisma.TransactionClient | typeof prisma;

// The assumption behind "hours saved", surfaced verbatim in the UI footnote.
// Vendors configure this per tenant; 15 min of tech time per auto-resolved
// access/license action is the conservative mid-range.
export const MINUTES_SAVED_PER_AUTO = 15;
export const VOLUME_DAYS = 7;

export interface KindRate {
  kind: string;
  autoResolved: number;
  terminal: number;
  rate: number | null;
}

export interface DailyVolume {
  date: string; // yyyy-mm-dd, UTC
  auto: number;
  humanApproved: number;
  denied: number;
}

export interface Metrics {
  autoResolution: {
    autoResolved: number;
    terminal: number;
    rate: number | null; // null when there is no terminal history yet
    byKind: KindRate[];
  };
  hoursSaved: {
    autoResolved: number;
    minutesPerAction: number;
    hours: number;
  };
  autonomous: {
    executed: number;
    failed: number;
    successRate: number | null; // null until a graduated rule has run
  };
  latency: {
    medianFirstResponseMs: number | null;
    medianApprovalMs: number | null;
  };
  dailyVolume: DailyVolume[]; // oldest → newest, always VOLUME_DAYS entries
  computedAt: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The authoritative registry of graduation-created rules is the audit chain:
// `policy.created { via: "graduation" }` events. TrustState.graduatedPolicyId
// is NOT sufficient — it is overwritten on re-graduation, losing the old rule's
// id, while the chain is append-only. Trade-off: policies inserted by hand
// (test fixtures) are invisible here, so tests drive real accept flows.
async function graduatedPolicyIds(db: Db): Promise<Set<string>> {
  const events = await db.auditEvent.findMany({
    where: { action: "policy.created" },
    select: { targetId: true, detail: true },
  });
  const ids = new Set<string>();
  for (const e of events) {
    const detail = safeJsonParse<{ via?: string }>(e.detail, {});
    if (detail.via === "graduation") ids.add(e.targetId);
  }
  return ids;
}

export async function computeMetrics(db: Db = prisma): Promise<Metrics> {
  const runs = await db.actionRun.findMany({
    where: { status: { in: ["executed", "failed", "denied"] } },
    select: {
      kind: true,
      status: true,
      policyId: true,
      approval: { select: { status: true } },
    },
  });

  // Auto-resolution: executed with no approval row = no human ever touched it.
  const isAuto = (r: (typeof runs)[number]) =>
    r.status === "executed" && r.approval === null;
  const autoResolved = runs.filter(isAuto).length;

  const byKindMap = new Map<string, { autoResolved: number; terminal: number }>();
  for (const r of runs) {
    const entry = byKindMap.get(r.kind) ?? { autoResolved: 0, terminal: 0 };
    entry.terminal++;
    if (isAuto(r)) entry.autoResolved++;
    byKindMap.set(r.kind, entry);
  }
  const byKind: KindRate[] = [...byKindMap.entries()]
    .map(([kind, v]) => ({
      kind,
      ...v,
      rate: v.terminal === 0 ? null : v.autoResolved / v.terminal,
    }))
    .sort((a, b) => b.terminal - a.terminal);

  // Autonomous success: only runs executed under a graduation-created rule.
  const gradIds = await graduatedPolicyIds(db);
  let autonomousExecuted = 0;
  let autonomousFailed = 0;
  for (const r of runs) {
    if (!r.policyId || !gradIds.has(r.policyId) || r.approval !== null) continue;
    if (r.status === "executed") autonomousExecuted++;
    else if (r.status === "failed") autonomousFailed++;
  }
  const autonomousTotal = autonomousExecuted + autonomousFailed;

  // First response: the first non-employee message on a ticket — the moment
  // the requester heard back from the system or a human.
  const tickets = await db.ticket.findMany({
    select: {
      createdAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { authorType: true, createdAt: true },
      },
    },
  });
  const firstResponses: number[] = [];
  for (const t of tickets) {
    const first = t.messages.find((m) => m.authorType !== "employee");
    if (!first) continue;
    const delta = first.createdAt.getTime() - t.createdAt.getTime();
    if (delta >= 0) firstResponses.push(delta);
  }

  const approvals = await db.approval.findMany({
    where: { decidedAt: { not: null } },
    select: { createdAt: true, decidedAt: true },
  });
  const approvalLatencies = approvals
    .map((a) => a.decidedAt!.getTime() - a.createdAt.getTime())
    .filter((ms) => ms >= 0);

  // Daily volume, one bucket per UTC day. A ticket counts once: a human "no"
  // outranks a human "yes" outranks an untouched auto run; tickets with no
  // terminal outcome yet (pending, failed-only) stay out of the chart.
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCHours(0, 0, 0, 0);
  windowStart.setUTCDate(windowStart.getUTCDate() - (VOLUME_DAYS - 1));

  const volumeTickets = await db.ticket.findMany({
    where: { createdAt: { gte: windowStart } },
    select: {
      createdAt: true,
      actions: {
        select: { status: true, approval: { select: { status: true } } },
      },
    },
  });
  const buckets = new Map<string, DailyVolume>();
  for (let i = 0; i < VOLUME_DAYS; i++) {
    const d = new Date(windowStart);
    d.setUTCDate(d.getUTCDate() + i);
    const key = utcDay(d);
    buckets.set(key, { date: key, auto: 0, humanApproved: 0, denied: 0 });
  }
  for (const t of volumeTickets) {
    const bucket = buckets.get(utcDay(t.createdAt));
    if (!bucket) continue;
    const denied = t.actions.some(
      (a) => a.status === "denied" || a.approval?.status === "denied",
    );
    const humanApproved = t.actions.some((a) => a.approval?.status === "approved");
    const auto = t.actions.some((a) => a.status === "executed" && a.approval === null);
    if (denied) bucket.denied++;
    else if (humanApproved) bucket.humanApproved++;
    else if (auto) bucket.auto++;
  }

  return {
    autoResolution: {
      autoResolved,
      terminal: runs.length,
      rate: runs.length === 0 ? null : autoResolved / runs.length,
      byKind,
    },
    hoursSaved: {
      autoResolved,
      minutesPerAction: MINUTES_SAVED_PER_AUTO,
      hours: (autoResolved * MINUTES_SAVED_PER_AUTO) / 60,
    },
    autonomous: {
      executed: autonomousExecuted,
      failed: autonomousFailed,
      successRate:
        autonomousTotal === 0 ? null : autonomousExecuted / autonomousTotal,
    },
    latency: {
      medianFirstResponseMs: median(firstResponses),
      medianApprovalMs: median(approvalLatencies),
    },
    dailyVolume: [...buckets.values()],
    computedAt: new Date().toISOString(),
  };
}
