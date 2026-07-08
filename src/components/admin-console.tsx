"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CEREMONY_MS, partitionByCeremony } from "@/components/ceremony";
import type { Metrics } from "@/lib/metrics";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
// 2500ms poll. Keep in sync with the gl-breathe 2.5s lamp cycle in globals.css —
// the header signal is meant to beat with the console's heartbeat.
const POLL = { refreshInterval: 2500 };

// Shared max-width for every tab's content column — one source of truth so the
// seven tab bodies can't drift apart.
const COL = "mx-auto w-full max-w-[54rem]";

// The one motion moment: on approve/accept, the card's signal rail turns green
// and holds briefly before the card moves to Decided. Skipped entirely under
// prefers-reduced-motion; deny/decline stay instant (no ceremony on a red action).
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Hold the celebrating card while its rail turns green, then release. No-op under
// prefers-reduced-motion. The caller keeps `busy` set across the hold so the
// buttons can't double-fire during it.
async function playCeremony(
  id: string,
  setCelebrating: (v: string | null) => void,
) {
  if (prefersReducedMotion()) return;
  setCelebrating(id);
  await new Promise((r) => setTimeout(r, CEREMONY_MS));
}

// Fire a mutation and report failure instead of swallowing it. Privileged actions
// (approve, graduate, revoke, outage) must never silently no-op on a 403/500/network
// error — the caller surfaces `error` in the UI so the admin knows it didn't take.
// Returns the parsed 2xx body so the caller can also catch no-op successes (a
// connector that failed, a proposal that went stale) that come back as 200s.
async function postJson<T = unknown>(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
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
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: true, data };
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

// Empty tab body: a dim, unlit lamp above the directive line — the signal
// idles until there's something to decide.
function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 p-10 text-center">
      <span className="gl-lamp-dim" aria-hidden />
      <p className="text-sm text-neutral-500">{children}</p>
    </div>
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
  solved: "bg-go-50 text-go-700 border-go-200",
  pending_approval: "bg-amber-50 text-amber-700 border-amber-200",
  denied: "bg-red-50 text-red-700 border-red-200",
  in_progress: "bg-neutral-100 text-neutral-600 border-neutral-200",
  new: "bg-neutral-100 text-neutral-600 border-neutral-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-go-50 text-go-700 border-go-200",
  // graduation proposals
  accepted: "bg-violet-50 text-violet-700 border-violet-200",
  declined: "bg-red-50 text-red-700 border-red-200",
  stale: "bg-neutral-100 text-neutral-600 border-neutral-200",
  // trust ledger
  supervised: "bg-neutral-100 text-neutral-600 border-neutral-200",
  proposed: "bg-violet-50 text-violet-700 border-violet-200",
  autonomous: "bg-go-50 text-go-700 border-go-200",
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
      <div className={`${COL} flex flex-col gap-2 p-4`}>
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
        {tickets?.length === 0 && <EmptyState>Queue is clear.</EmptyState>}
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
  source: string; // "streak" (earned, reviewed in Approvals) | "pattern_miner" (discovered, reviewed in Suggestions)
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
  celebrating = false,
  onDecide,
}: {
  proposal: GraduationRow;
  busy: boolean;
  celebrating?: boolean;
  onDecide: (id: string, decision: "accepted" | "declined") => void;
}) {
  const preview = proposal.impactPreview;
  const tickets = proposal.evidence.ticketNumbers ?? [];
  return (
    <div
      className={`rounded-lg border border-l-[3px] px-4 py-3 transition-colors duration-500 ${
        celebrating
          ? "border-go-300 border-l-go-600 bg-go-50"
          : "border-l-violet-500 bg-white"
      }`}
    >
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
        <div className="mt-2.5 rounded-md border border-violet-100 bg-violet-50/40 px-3 py-2.5 text-xs">
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
  const [celebrating, setCelebrating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  const decide = async (id: string, decision: "approved" | "denied") => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson<{ executed?: boolean; result?: { error?: string } }>(
        `/api/approvals/${id}`,
        { decision },
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A 200 with executed:false means the approval was recorded but its
      // connector action failed (e.g. a simulated outage). Surface that instead
      // of playing the green "GO" ceremony on an action that didn't take.
      if (decision === "approved" && res.data.executed === false) {
        setError(
          res.data.result?.error
            ? `Approved, but the action failed: ${res.data.result.error}`
            : "Approved, but the action didn't execute — check the ticket and retry.",
        );
      } else if (decision === "approved") {
        setAnnounce("Approval granted and the action executed.");
        await playCeremony(id, setCelebrating);
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
      setCelebrating(null);
    }
  };

  const decideProposal = async (id: string, decision: "accepted" | "declined") => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson<{ status?: string; reason?: string }>(
        `/api/graduations/${id}`,
        { decision },
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // An accepted proposal can come back "stale" (200, but no rule created)
      // when the policy table moved since it was proposed. Don't celebrate a
      // graduation that didn't happen.
      if (decision === "accepted" && res.data.status === "stale") {
        setError(
          res.data.reason ??
            "This proposal went stale before you accepted it — no policy change was made.",
        );
      } else if (decision === "accepted") {
        setAnnounce("Proposal accepted — autonomy granted for this shape.");
        await playCeremony(id, setCelebrating);
      }
      await Promise.all([
        mutate("/api/graduations"),
        mutate("/api/policies"),
        mutate("/api/audit"),
        mutate("/api/trust"),
      ]);
    } finally {
      setBusy(null);
      setCelebrating(null);
    }
  };

  // The celebrating card stays in the pending list (and out of Decided) even if
  // the 2.5s poll revalidates mid-hold — otherwise the ceremony gets cut short.
  const { pending, decided } = partitionByCeremony(approvals, celebrating);
  // Earned proposals only — discovered (pattern-mined) ones live in Suggestions.
  const earned = graduations?.filter((g) => g.source === "streak") ?? [];
  const { pending: pendingProposals, decided: decidedProposals } =
    partitionByCeremony(earned, celebrating);

  return (
    <ScrollArea className="h-full">
      <div className={`${COL} flex flex-col gap-2 p-4`}>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
        {error && <ErrorBanner message={error} />}
        {(!approvals || !graduations) && <SkeletonRows />}
        {approvals && graduations && pending.length === 0 && pendingProposals.length === 0 && (
          <EmptyState>Nothing waiting on you. Sensitive requests will land here.</EmptyState>
        )}
        {pendingProposals.map((g) => (
          <ProposalCard
            key={g.id}
            proposal={g}
            busy={busy === g.id}
            celebrating={celebrating === g.id}
            onDecide={decideProposal}
          />
        ))}
        {pending.map((a) => (
          <div
            key={a.id}
            className={`rounded-lg border border-l-[3px] px-4 py-3 transition-colors duration-500 ${
              celebrating === a.id
                ? "border-go-300 border-l-go-600 bg-go-50"
                : "border-l-amber-500 bg-white"
            }`}
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

// ---- Suggestions -------------------------------------------------------------

// A pattern the miner found in action history: a shape that recurred cleanly but
// still routes to a human. Candidates are computed live on every poll — nothing
// persists until an admin promotes one into a real graduation proposal.
interface SuggestionRow {
  shapeKey: string;
  label: string;
  occurrences: number;
  threshold: number;
  ticketNumbers: number[];
  lastSeenAt: string;
  blockedBy: { policyId: string | null; name: string };
  windowDays: number;
}

function SuggestionsTab() {
  const { data: candidates } = useSWR<SuggestionRow[]>("/api/suggestions", fetcher, POLL);
  const { data: graduations } = useSWR<GraduationRow[]>("/api/graduations", fetcher, POLL);
  const [busy, setBusy] = useState<string | null>(null);
  const [celebrating, setCelebrating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  const promote = async (shapeKey: string) => {
    setBusy(shapeKey);
    setError(null);
    try {
      const res = await postJson("/api/suggestions/promote", { shapeKey });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // The candidate card swaps for its proposal card in place.
      await Promise.all([
        mutate("/api/suggestions"),
        mutate("/api/graduations"),
        mutate("/api/trust"),
        mutate("/api/audit"),
      ]);
    } finally {
      setBusy(null);
    }
  };

  const decideProposal = async (id: string, decision: "accepted" | "declined") => {
    setBusy(id);
    setError(null);
    try {
      const res = await postJson<{ status?: string; reason?: string }>(
        `/api/graduations/${id}`,
        { decision },
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A stale accept is a 200 that created no rule (see ApprovalsTab) — surface
      // it rather than celebrating a graduation that didn't happen.
      if (decision === "accepted" && res.data.status === "stale") {
        setError(
          res.data.reason ??
            "This proposal went stale before you accepted it — no policy change was made.",
        );
      } else if (decision === "accepted") {
        setAnnounce("Proposal accepted — autonomy granted for this shape.");
        await playCeremony(id, setCelebrating);
      }
      await Promise.all([
        mutate("/api/suggestions"),
        mutate("/api/graduations"),
        mutate("/api/policies"),
        mutate("/api/audit"),
        mutate("/api/trust"),
      ]);
    } finally {
      setBusy(null);
      setCelebrating(null);
    }
  };

  const mined = graduations?.filter((g) => g.source === "pattern_miner") ?? [];
  // Celebrating cards hold their spot through a mid-ceremony poll (see ApprovalsTab).
  const { pending: pendingMined, decided: decidedMined } =
    partitionByCeremony(mined, celebrating);

  return (
    <ScrollArea className="h-full">
      <div className={`${COL} flex flex-col gap-2 p-4`}>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
        <p className="text-xs text-neutral-500">
          Patterns mined from action history: shapes that keep getting approved cleanly
          but still route to a human. Approvals shows autonomy the agent earned;
          this shows autonomy the system discovered. Nothing activates without your accept.
        </p>
        {error && <ErrorBanner message={error} />}
        {(!candidates || !graduations) && <SkeletonRows />}
        {candidates &&
          graduations &&
          candidates.length === 0 &&
          pendingMined.length === 0 && (
            <EmptyState>No patterns yet — as approvals recur, candidates surface here.</EmptyState>
          )}
        {pendingMined.map((g) => (
          <ProposalCard
            key={g.id}
            proposal={g}
            busy={busy === g.id}
            celebrating={celebrating === g.id}
            onDecide={decideProposal}
          />
        ))}
        {candidates?.map((c) => (
          <div
            key={c.shapeKey}
            className="rounded-lg border border-l-[3px] border-l-violet-500 bg-white px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-600">
                  Discovered pattern
                </div>
                <div className="mt-0.5 truncate text-sm font-medium">{c.label}</div>
                <div className="mt-0.5 truncate text-xs text-neutral-500">
                  {c.occurrences}× approved cleanly in the last {c.windowDays} days
                  {c.ticketNumbers.length > 0 && (
                    <> · {c.ticketNumbers.map((n) => `TKT-${n}`).join(" · ")}</>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2.5">
                  <StreakBar value={c.occurrences} max={c.threshold} full />
                  <span className="text-xs text-neutral-500">
                    blocked by “{c.blockedBy.name}”
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                disabled={busy === c.shapeKey}
                onClick={() => promote(c.shapeKey)}
                className="shrink-0 bg-violet-600 hover:bg-violet-700"
              >
                Propose graduation
              </Button>
            </div>
          </div>
        ))}
        {decidedMined.length > 0 && (
          <>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Decided
            </p>
            {decidedMined.map((g) => (
              <div key={g.id} className="rounded-lg border bg-white px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-600">
                    Suggestion · {g.label}
                    {g.deciderNote ? (
                      <span className="text-neutral-400"> — {g.deciderNote}</span>
                    ) : null}
                  </span>
                  <StatusPill value={g.status} />
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
      <div className={`${COL} p-4`}>
        {!events && (
          <div className="flex flex-col gap-2">
            <SkeletonRows rows={6} className="h-6" />
          </div>
        )}
        {events && events.length > 0 && (
        <table className="w-full text-left font-mono text-xs">
          <thead>
            <tr className="border-b text-[10px] tracking-wider text-neutral-500 uppercase">
              <th className="py-1.5 pr-3 font-medium">actor</th>
              <th className="py-1.5 pr-3 font-medium">action</th>
              <th className="py-1.5 pr-3 font-medium">target</th>
              <th className="py-1.5 pr-3 font-medium">detail</th>
              <th className="py-1.5 pl-4 font-medium">hash</th>
            </tr>
          </thead>
          <tbody>
            {events?.map((e) => (
              <tr key={e.id} className="border-b border-neutral-100 align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className="font-medium">{e.actorType}</span>
                  <span className="text-neutral-500">/{e.actorId}</span>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{e.action}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{e.target}</td>
                <td className="max-w-[16rem] truncate py-1.5 pr-3 text-neutral-500">
                  {(e.detail.summary as string) ??
                    (e.detail.rule as string) ??
                    (e.detail.description as string) ??
                    ""}
                </td>
                <td
                  className="gl-hash py-1.5 pl-4 text-neutral-500"
                  title={`hash: ${e.hash}\nEach hash covers the previous one — the chain breaks if history is edited.`}
                >
                  {e.hash.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
        {events?.length === 0 && <EmptyState>No activity yet.</EmptyState>}
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
  auto_approve: "bg-go-50 text-go-700 border-go-200",
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
      <div className={`${COL} flex flex-col gap-2 p-4`}>
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
      <div className={`${COL} flex flex-col gap-2 p-4`}>
        <p className="text-xs text-neutral-500">
          Trust is earned per action shape, never assumed. Clean approvals build a streak;
          at the bar, the system proposes autonomy with the policy diff as the approval
          artifact. One bad autonomous run — or one click here — revokes it.
        </p>
        {error && <ErrorBanner message={error} />}
        {!shapes && <SkeletonRows />}
        {shapes?.length === 0 && (
          <EmptyState>No trust history yet — approvals build per-shape track records here.</EmptyState>
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
                    <span className="text-xs font-medium text-go-700">
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
                          ? "awaiting review"
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

// ---- Insights ------------------------------------------------------------------
// Shape comes straight from computeMetrics() via /api/metrics (Response.json,
// no reshaping), so we reuse the server type instead of re-declaring it.

function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Max stacked-bar height in px. Sits below the h-24 (96px) column container so
// a full-height stack plus inter-segment gaps never clips.
const BAR_MAX_PX = 88;

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

// Live business outcomes over the same tables the demo writes — the numbers
// move on the next poll after an action runs. Colors carry the console's
// status vocabulary (emerald = untouched auto, amber = human-approved,
// red = denied); exact splits ride each column's tooltip.
function InsightsTab() {
  const { data: m } = useSWR<Metrics>("/api/metrics", fetcher, POLL);

  const maxDay = m
    ? Math.max(1, ...m.dailyVolume.map((d) => d.auto + d.humanApproved + d.denied))
    : 1;

  return (
    <ScrollArea className="h-full">
      <div className={`${COL} flex flex-col gap-2 p-4`}>
        <p className="text-xs text-neutral-500">
          Coverage and outcomes, live from the action history — run an action and
          watch the numbers move. Nothing here is a projection except the minutes
          assumption, which is printed where it&apos;s used.
        </p>
        {!m && <SkeletonRows />}
        {m && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <StatTile
                label="Auto-resolved"
                value={formatPercent(m.autoResolution.rate)}
                sub={`${m.autoResolution.autoResolved} of ${m.autoResolution.terminal} actions, no human touch`}
              />
              <StatTile
                label="Hours saved"
                value={`${m.hoursSaved.hours.toFixed(1)}h`}
                sub={`assumes ${m.hoursSaved.minutesPerAction} min of IT time per auto-resolved action`}
              />
              <StatTile
                label="Autonomous success"
                value={formatPercent(m.autonomous.successRate)}
                sub={
                  m.autonomous.executed + m.autonomous.failed === 0
                    ? "no graduated-rule runs yet"
                    : `${m.autonomous.executed} ok · ${m.autonomous.failed} failed under graduated rules`
                }
              />
              <StatTile
                label="Median first response"
                value={formatDuration(m.latency.medianFirstResponseMs)}
                sub={`human approval decision ${formatDuration(m.latency.medianApprovalMs)}`}
              />
            </div>

            <div className="grid gap-2 lg:grid-cols-2">
              <div className="rounded-lg border bg-white px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                  Auto-resolution by action kind
                </div>
                <div className="mt-2.5 flex flex-col gap-2.5">
                  {m.autoResolution.byKind.map((k) => (
                    <div key={k.kind} className="flex items-center gap-2.5">
                      <span className="w-32 shrink-0 text-xs text-neutral-600">
                        {k.kind.replace(/_/g, " ")}
                      </span>
                      <div
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200/70"
                        role="progressbar"
                        aria-valuenow={k.autoResolved}
                        aria-valuemin={0}
                        aria-valuemax={k.terminal}
                        aria-label={`${k.kind}: ${k.autoResolved} of ${k.terminal} auto-resolved`}
                      >
                        <div
                          className="h-full rounded-full bg-go-600 transition-all"
                          style={{ width: `${(k.rate ?? 0) * 100}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-500">
                        {k.autoResolved}/{k.terminal}
                      </span>
                    </div>
                  ))}
                  {m.autoResolution.byKind.length === 0 && (
                    <p className="text-xs text-neutral-400">No actions yet.</p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-white px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                    Tickets · last 7 days
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-neutral-500">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-[2px] bg-go-600" /> auto
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-[2px] bg-amber-600" /> human-approved
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-[2px] bg-red-600" /> denied
                    </span>
                  </div>
                </div>
                <div className="mt-2.5 flex items-end gap-2">
                  {m.dailyVolume.map((d) => {
                    const total = d.auto + d.humanApproved + d.denied;
                    return (
                      <div
                        key={d.date}
                        className="flex flex-1 flex-col items-center gap-1"
                        title={`${d.date}: ${d.auto} auto · ${d.humanApproved} human-approved · ${d.denied} denied`}
                      >
                        <span className="text-[10px] tabular-nums text-neutral-500">
                          {total > 0 ? total : ""}
                        </span>
                        <div className="flex h-24 w-full max-w-8 flex-col justify-end">
                          {total === 0 ? (
                            <div className="h-[2px] rounded-full bg-neutral-200/70" />
                          ) : (
                            <div className="flex flex-col gap-[2px] overflow-hidden rounded-t-[4px]">
                              {d.denied > 0 && (
                                <div
                                  className="w-full bg-red-600"
                                  style={{ height: `${(d.denied / maxDay) * BAR_MAX_PX}px` }}
                                />
                              )}
                              {d.humanApproved > 0 && (
                                <div
                                  className="w-full bg-amber-600"
                                  style={{ height: `${(d.humanApproved / maxDay) * BAR_MAX_PX}px` }}
                                />
                              )}
                              {d.auto > 0 && (
                                <div
                                  className="w-full bg-go-600"
                                  style={{ height: `${(d.auto / maxDay) * BAR_MAX_PX}px` }}
                                />
                              )}
                            </div>
                          )}
                        </div>
                        <span className="text-[10px] text-neutral-500">
                          {WEEKDAYS[new Date(`${d.date}T00:00:00Z`).getUTCDay()]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// ---- shell -------------------------------------------------------------------

// Signage-style tab labels: Overpass uppercase micro-labels with the go-green
// underline supplied by the TabsList `line` variant (after:bg-* merges via cn).
// text-foreground/75 lifts inactive labels above the WCAG-AA floor at this 11px
// size — the shadcn default /60 falls short once the labels shrink. The active
// tab keeps full foreground via the component's data-active variant.
const TAB_CLASS =
  "font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/75 after:bg-go-600";

export function AdminConsole() {
  // Establish the IT-console admin session (demo seam). Approve/deny and policy toggles
  // require a valid admin session server-side; without it they return 403.
  useEffect(() => {
    fetch("/api/session/admin", { method: "POST" }).catch(() => {});
  }, []);

  const { data: approvals } = useSWR<ApprovalRow[]>("/api/approvals", fetcher, POLL);
  const { data: graduations } = useSWR<GraduationRow[]>("/api/graduations", fetcher, POLL);
  const { data: suggestions } = useSWR<SuggestionRow[]>("/api/suggestions", fetcher, POLL);
  const pendingCount =
    (approvals?.filter((a) => a.status === "pending").length ?? 0) +
    (graduations?.filter((g) => g.status === "pending" && g.source === "streak")
      .length ?? 0);
  const suggestionCount =
    (suggestions?.length ?? 0) +
    (graduations?.filter(
      (g) => g.status === "pending" && g.source === "pattern_miner",
    ).length ?? 0);

  return (
    <Tabs defaultValue="queue" className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex items-center justify-between border-b bg-white px-4 pt-2 pb-1.5">
        <TabsList variant="line" className="gap-3">
          <TabsTrigger className={TAB_CLASS} value="queue">Queue</TabsTrigger>
          <TabsTrigger className={TAB_CLASS} value="approvals">
            Approvals
            {pendingCount > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
                {pendingCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger className={TAB_CLASS} value="suggestions">
            Suggestions
            {suggestionCount > 0 && (
              <span className="ml-1.5 rounded-full bg-violet-500 px-1.5 text-[10px] font-semibold text-white">
                {suggestionCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger className={TAB_CLASS} value="trust">Trust</TabsTrigger>
          <TabsTrigger className={TAB_CLASS} value="insights">Insights</TabsTrigger>
          <TabsTrigger className={TAB_CLASS} value="audit">Audit log</TabsTrigger>
          <TabsTrigger className={TAB_CLASS} value="policies">Policies</TabsTrigger>
        </TabsList>
        <span className="hidden text-xs whitespace-nowrap text-neutral-500 lg:block">
          IT console · Taylor Kim
        </span>
      </div>
      <TabsContent value="queue" className="min-h-0 flex-1">
        <QueueTab />
      </TabsContent>
      <TabsContent value="approvals" className="min-h-0 flex-1">
        <ApprovalsTab />
      </TabsContent>
      <TabsContent value="suggestions" className="min-h-0 flex-1">
        <SuggestionsTab />
      </TabsContent>
      <TabsContent value="trust" className="min-h-0 flex-1">
        <TrustTab />
      </TabsContent>
      <TabsContent value="insights" className="min-h-0 flex-1">
        <InsightsTab />
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
