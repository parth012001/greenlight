"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const POLL = { refreshInterval: 2500 };

// Fire a mutation and report failure instead of swallowing it. Privileged actions
// (approve, graduate, revoke, outage) must never silently no-op on a 403/500/network
// error — the caller surfaces `error` in the UI so the admin knows it didn't take.
async function postJson(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `Request failed (${res.status})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error — please retry." };
  }
}

// Loading placeholder rows, rendered while SWR data is still undefined (first paint)
// so a tab shows structure instead of a blank panel.
function SkeletonRows({ rows = 4, className = "h-16" }: { rows?: number; className?: string }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`${className} w-full rounded-lg`} />
      ))}
    </>
  );
}

// Inline failure notice for a mutation that didn't take — so a silently-failed
// privileged action can't read as success.
function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
    >
      {message}
    </p>
  );
}

const STATUS_STYLES: Record<string, string> = {
  solved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending_approval: "bg-amber-50 text-amber-700 border-amber-200",
  denied: "bg-red-50 text-red-700 border-red-200",
  in_progress: "bg-blue-50 text-blue-700 border-blue-200",
  new: "bg-neutral-100 text-neutral-600 border-neutral-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  // graduation proposals
  accepted: "bg-violet-50 text-violet-700 border-violet-200",
  declined: "bg-red-50 text-red-700 border-red-200",
  stale: "bg-neutral-100 text-neutral-600 border-neutral-200",
  // trust ledger
  supervised: "bg-neutral-100 text-neutral-600 border-neutral-200",
  proposed: "bg-violet-50 text-violet-700 border-violet-200",
  autonomous: "bg-emerald-50 text-emerald-700 border-emerald-200",
  demoted: "bg-red-50 text-red-700 border-red-200",
};

function StatusPill({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[value] ?? STATUS_STYLES.new}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

// ---- Queue ----------------------------------------------------------------

interface TicketRow {
  id: string;
  number: number;
  subject: string;
  category: string;
  status: string;
  requester: string;
  role: string;
  lastNote: string | null;
  updatedAt: string;
}

function QueueTab() {
  const { data: tickets } = useSWR<TicketRow[]>("/api/tickets", fetcher, POLL);
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        {!tickets && <SkeletonRows />}
        {tickets?.map((t) => (
          <div key={t.id} className="rounded-lg border bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-neutral-500">
                  TKT-{t.number}
                </span>
                <span className="font-medium">{t.subject}</span>
              </div>
              <StatusPill value={t.status} />
            </div>
            {t.lastNote && (
              <p className="mt-1 truncate text-xs text-neutral-500">{t.lastNote}</p>
            )}
          </div>
        ))}
        {tickets?.length === 0 && (
          <p className="p-6 text-center text-sm text-neutral-500">Queue is clear.</p>
        )}
      </div>
    </ScrollArea>
  );
}

// ---- Approvals -------------------------------------------------------------

interface ApprovalRow {
  id: string;
  summary: string;
  status: string;
  ticketNumber: number;
  requester: string;
  role: string;
  justification?: string;
  decidedBy: string | null;
  deciderNote: string | null;
}

// A graduation proposal as the console sees it — the decision artifact is the
// parsed policy diff + replay preview.
interface GraduationRow {
  id: string;
  shapeKey: string;
  label: string;
  policyName: string;
  status: string;
  evidence: { streak?: number; threshold?: number; ticketNumbers?: number[] };
  impactPreview: {
    diff: {
      before: { policyId: string | null; name: string; effect: string };
      after: { name: string; effect: string; insertBeforePolicyId: string | null };
    };
    replay: {
      runsEvaluated: number;
      skipped: number;
      changed: number;
      onlyTargetShapeChanges: boolean;
    };
    computedAt: string;
  } | null;
  deciderNote: string | null;
}

function EffectPill({ effect }: { effect: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${EFFECT_STYLES[effect] ?? ""}`}
    >
      {effect.replace("_", " ")}
    </span>
  );
}

// The graduation card: a policy change as an approval artifact. Shows the rule
// diff (what gates the shape now → the narrow auto-approve rule accept creates)
// and the replay line proving the blast radius is exactly this shape.
function ProposalCard({
  proposal,
  busy,
  onDecide,
}: {
  proposal: GraduationRow;
  busy: boolean;
  onDecide: (id: string, decision: "accepted" | "declined") => void;
}) {
  const preview = proposal.impactPreview;
  const tickets = proposal.evidence.ticketNumbers ?? [];
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-600">
            Graduation proposal
          </div>
          <div className="mt-0.5 truncate text-sm font-medium">
            Graduate to auto-approve: {proposal.label}
          </div>
          <div className="mt-0.5 truncate text-xs text-neutral-500">
            {proposal.evidence.streak ?? "?"} clean approvals, no overrides
            {tickets.length > 0 && <> · {tickets.map((n) => `TKT-${n}`).join(" · ")}</>}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onDecide(proposal.id, "accepted")}
            className="bg-violet-600 hover:bg-violet-700"
          >
            Accept &amp; create rule
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onDecide(proposal.id, "declined")}
          >
            Decline
          </Button>
        </div>
      </div>
      {preview && (
        <div className="mt-2.5 rounded-md border border-violet-100 bg-white px-3 py-2.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-neutral-400">now</span>
            <EffectPill effect={preview.diff.before.effect} />
            <span className="truncate text-neutral-600">{preview.diff.before.name}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-10 shrink-0 text-neutral-400">after</span>
            <EffectPill effect="auto_approve" />
            <span className="truncate font-medium">{proposal.policyName}</span>
            <span className="whitespace-nowrap text-neutral-400">
              {preview.diff.after.insertBeforePolicyId
                ? "· inserted above the current rule"
                : "· appended to the rule list"}
            </span>
          </div>
          <p
            className={`mt-2 border-t border-neutral-100 pt-1.5 ${preview.replay.onlyTargetShapeChanges ? "text-neutral-500" : "font-medium text-red-600"}`}
          >
            {preview.replay.onlyTargetShapeChanges ? (
              <>
                Replayed the last {preview.replay.runsEvaluated} actions: {preview.replay.changed}{" "}
                flip to auto-approve — all this exact shape, nothing else changes.
              </>
            ) : (
              <>
                Replay warning: this change would flip actions beyond the proposed shape —
                review before accepting.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function ApprovalsTab() {
  const { data: approvals } = useSWR<ApprovalRow[]>("/api/approvals", fetcher, POLL);
  const { data: graduations } = useSWR<GraduationRow[]>("/api/graduations", fetcher, POLL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, decision: "approved" | "denied") => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson(`/api/approvals/${id}`, { decision });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Trust + graduations refresh immediately: the approval that crosses a
      // threshold must pop its proposal card now, not on the next poll.
      await Promise.all([
        mutate("/api/approvals"),
        mutate("/api/tickets"),
        mutate("/api/audit"),
        mutate("/api/trust"),
        mutate("/api/graduations"),
      ]);
    } finally {
      setBusy(null);
    }
  };

  const decideProposal = async (id: string, decision: "accepted" | "declined") => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson(`/api/graduations/${id}`, { decision });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await Promise.all([
        mutate("/api/graduations"),
        mutate("/api/policies"),
        mutate("/api/audit"),
        mutate("/api/trust"),
      ]);
    } finally {
      setBusy(null);
    }
  };

  const pending = approvals?.filter((a) => a.status === "pending") ?? [];
  const decided = approvals?.filter((a) => a.status !== "pending") ?? [];
  const pendingProposals = graduations?.filter((g) => g.status === "pending") ?? [];
  const decidedProposals = graduations?.filter((g) => g.status !== "pending") ?? [];

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        {error && <ErrorBanner message={error} />}
        {(!approvals || !graduations) && <SkeletonRows />}
        {approvals && graduations && pending.length === 0 && pendingProposals.length === 0 && (
          <p className="p-6 text-center text-sm text-neutral-500">
            Nothing waiting on you. Sensitive requests will land here.
          </p>
        )}
        {pendingProposals.map((g) => (
          <ProposalCard
            key={g.id}
            proposal={g}
            busy={busy === g.id}
            onDecide={decideProposal}
          />
        ))}
        {pending.map((a) => (
          <div
            key={a.id}
            className="rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{a.summary}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  TKT-{a.ticketNumber}
                  {a.justification ? ` · “${a.justification}”` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  disabled={busy === a.id}
                  onClick={() => decide(a.id, "approved")}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === a.id}
                  onClick={() => decide(a.id, "denied")}
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                >
                  Deny
                </Button>
              </div>
            </div>
          </div>
        ))}
        {(decided.length > 0 || decidedProposals.length > 0) && (
          <>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Decided
            </p>
            {decidedProposals.map((g) => (
              <div key={g.id} className="rounded-lg border bg-white px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-600">
                    Graduation · {g.label}
                    {g.deciderNote ? (
                      <span className="text-neutral-400"> — {g.deciderNote}</span>
                    ) : null}
                  </span>
                  <StatusPill value={g.status} />
                </div>
              </div>
            ))}
            {decided.map((a) => (
              <div key={a.id} className="rounded-lg border bg-white px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-600">{a.summary}</span>
                  <StatusPill value={a.status} />
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// ---- Audit ------------------------------------------------------------------

interface AuditRow {
  id: number;
  ts: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  hash: string;
}

function AuditTab() {
  const { data: events } = useSWR<AuditRow[]>("/api/audit", fetcher, POLL);
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        {!events && (
          <div className="flex flex-col gap-2">
            <SkeletonRows rows={6} className="h-6" />
          </div>
        )}
        {events && events.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b text-neutral-500">
              <th className="py-1.5 pr-3 font-medium">actor</th>
              <th className="py-1.5 pr-3 font-medium">action</th>
              <th className="py-1.5 pr-3 font-medium">target</th>
              <th className="py-1.5 pr-3 font-medium">detail</th>
              <th className="py-1.5 font-medium">hash</th>
            </tr>
          </thead>
          <tbody>
            {events?.map((e) => (
              <tr key={e.id} className="border-b border-neutral-100 align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className="font-medium">{e.actorType}</span>
                  <span className="text-neutral-500">/{e.actorId}</span>
                </td>
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{e.action}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{e.target}</td>
                <td className="max-w-[16rem] truncate py-1.5 pr-3 text-neutral-500">
                  {(e.detail.summary as string) ??
                    (e.detail.rule as string) ??
                    (e.detail.description as string) ??
                    ""}
                </td>
                <td
                  className="py-1.5 font-mono text-neutral-500"
                  title={`hash: ${e.hash}\nEach hash covers the previous one — the chain breaks if history is edited.`}
                >
                  {e.hash.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
        {events?.length === 0 && (
          <p className="p-6 text-center text-sm text-neutral-500">No activity yet.</p>
        )}
      </div>
    </ScrollArea>
  );
}

// ---- Policies ----------------------------------------------------------------

interface PolicyRow {
  id: string;
  name: string;
  description: string;
  effect: string;
  enabled: boolean;
}

const EFFECT_STYLES: Record<string, string> = {
  auto_approve: "bg-emerald-50 text-emerald-700 border-emerald-200",
  require_approval: "bg-amber-50 text-amber-700 border-amber-200",
  deny: "bg-red-50 text-red-700 border-red-200",
};

interface AppRow {
  id: string;
  name: string;
  connectorKey: string;
  simulateFailure: boolean;
}

function PoliciesTab() {
  const { data: policies } = useSWR<PolicyRow[]>("/api/policies", fetcher, POLL);
  const { data: apps } = useSWR<AppRow[]>("/api/apps", fetcher, POLL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson(`/api/policies/${id}`, { enabled }, "PATCH");
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await Promise.all([mutate("/api/policies"), mutate("/api/audit")]);
    } finally {
      setBusy(null);
    }
  };

  const toggleOutage = async (id: string, simulateFailure: boolean) => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson(`/api/apps/${id}`, { simulateFailure }, "PATCH");
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await Promise.all([mutate("/api/apps"), mutate("/api/audit")]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        <p className="text-xs text-neutral-500">
          First matching rule wins, top to bottom. Toggle a rule and ask the agent again —
          its behavior changes instantly, because policy lives here, not in the model.
        </p>
        {error && <ErrorBanner message={error} />}
        {!policies && <SkeletonRows />}
        {policies?.map((p) => (
          <div
            key={p.id}
            className={`flex items-center justify-between gap-3 rounded-lg border bg-white px-4 py-3 ${p.enabled ? "" : "opacity-50"}`}
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.name}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${EFFECT_STYLES[p.effect]}`}
                >
                  {p.effect.replace("_", " ")}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-neutral-500">{p.description}</p>
            </div>
            <Switch
              checked={p.enabled}
              onCheckedChange={(v) => toggle(p.id, v)}
              disabled={busy === p.id}
              aria-label={`Toggle policy ${p.name}`}
            />
          </div>
        ))}
        {apps && apps.length > 0 && (
          <>
            <p className="mt-4 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Sandbox apps
            </p>
            <p className="text-xs text-neutral-500">
              Simulate an upstream outage: the next action against the app fails — and a
              failed autonomous run costs that shape its autonomy.
            </p>
            {apps.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-lg border bg-white px-4 py-2.5"
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{a.name}</span>
                  {a.simulateFailure && (
                    <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
                      outage
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-neutral-400">simulate outage</span>
                  <Switch
                    checked={a.simulateFailure}
                    onCheckedChange={(v) => toggleOutage(a.id, v)}
                    disabled={busy === a.id}
                    aria-label={`Simulate outage for ${a.name}`}
                  />
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// ---- Trust ledger --------------------------------------------------------------

interface TrustRow {
  shapeKey: string;
  label: string;
  status: string;
  cleanStreak: number;
  threshold: number;
  streakTicketNumbers: number[];
  totalApproved: number;
  totalDenied: number;
  autonomousRuns: number;
  updatedAt: string;
}

function StreakBar({ value, max, full }: { value: number; max: number; full?: boolean }) {
  const pct = full ? 100 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div
      className="h-1.5 w-36 overflow-hidden rounded-full bg-neutral-200/70"
      role="progressbar"
      aria-valuenow={full ? max : value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={`${full ? max : value} of ${max} clean approvals`}
    >
      <div
        className="h-full rounded-full bg-violet-500 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// Per-shape journey from supervised to autonomous — and back, when trust is lost.
function TrustTab() {
  const { data: shapes } = useSWR<TrustRow[]>("/api/trust", fetcher, POLL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (shapeKey: string) => {
    setBusy(shapeKey);
    setError(null);
    try {
      const res = await postJson("/api/trust/revoke", { shapeKey });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await Promise.all([
        mutate("/api/trust"),
        mutate("/api/policies"),
        mutate("/api/audit"),
      ]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        <p className="text-xs text-neutral-500">
          Trust is earned per action shape, never assumed. Clean approvals build a streak;
          at the bar, the system proposes autonomy with the policy diff as the approval
          artifact. One bad autonomous run — or one click here — revokes it.
        </p>
        {error && <ErrorBanner message={error} />}
        {!shapes && <SkeletonRows />}
        {shapes?.length === 0 && (
          <p className="p-6 text-center text-sm text-neutral-500">
            No trust history yet — approvals build per-shape track records here.
          </p>
        )}
        {shapes?.map((s) => (
          <div key={s.shapeKey} className="rounded-lg border bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.label}</span>
                  <StatusPill value={s.status} />
                </div>
                <div className="mt-2 flex items-center gap-2.5">
                  {s.status === "autonomous" ? (
                    <span className="text-xs font-medium text-emerald-700">
                      {s.autonomousRuns} autonomous {s.autonomousRuns === 1 ? "run" : "runs"} since graduation
                    </span>
                  ) : (
                    <>
                      <StreakBar
                        value={s.cleanStreak}
                        max={s.threshold}
                        full={s.status === "proposed"}
                      />
                      <span className="text-xs text-neutral-500">
                        {s.status === "proposed"
                          ? "awaiting review in Approvals"
                          : `${s.cleanStreak}/${s.threshold} clean approvals`}
                        {s.status === "demoted" && " · re-earning from zero"}
                      </span>
                    </>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-neutral-400">
                  {s.totalApproved} approved · {s.totalDenied} denied
                  {s.streakTicketNumbers.length > 0 && (
                    <> · streak: {s.streakTicketNumbers.map((n) => `TKT-${n}`).join(", ")}</>
                  )}
                </div>
              </div>
              {s.status === "autonomous" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === s.shapeKey}
                  onClick={() => revoke(s.shapeKey)}
                  className="shrink-0 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                >
                  Revoke autonomy
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ---- shell -------------------------------------------------------------------

export function AdminConsole() {
  // Establish the IT-console admin session (demo seam). Approve/deny and policy toggles
  // require a valid admin session server-side; without it they return 403.
  useEffect(() => {
    fetch("/api/session/admin", { method: "POST" }).catch(() => {});
  }, []);

  const { data: approvals } = useSWR<ApprovalRow[]>("/api/approvals", fetcher, POLL);
  const { data: graduations } = useSWR<GraduationRow[]>("/api/graduations", fetcher, POLL);
  const pendingCount =
    (approvals?.filter((a) => a.status === "pending").length ?? 0) +
    (graduations?.filter((g) => g.status === "pending").length ?? 0);

  return (
    <Tabs defaultValue="queue" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex items-center justify-between border-b bg-white px-4 py-2">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="approvals">
            Approvals
            {pendingCount > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
                {pendingCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="trust">Trust</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>
        <span className="text-xs text-neutral-500">IT console · Taylor Kim</span>
      </div>
      <TabsContent value="queue" className="min-h-0 flex-1">
        <QueueTab />
      </TabsContent>
      <TabsContent value="approvals" className="min-h-0 flex-1">
        <ApprovalsTab />
      </TabsContent>
      <TabsContent value="trust" className="min-h-0 flex-1">
        <TrustTab />
      </TabsContent>
      <TabsContent value="audit" className="min-h-0 flex-1">
        <AuditTab />
      </TabsContent>
      <TabsContent value="policies" className="min-h-0 flex-1">
        <PoliciesTab />
      </TabsContent>
    </Tabs>
  );
}
