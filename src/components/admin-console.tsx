"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const POLL = { refreshInterval: 2500 };

const STATUS_STYLES: Record<string, string> = {
  solved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending_approval: "bg-amber-50 text-amber-700 border-amber-200",
  denied: "bg-red-50 text-red-700 border-red-200",
  in_progress: "bg-blue-50 text-blue-700 border-blue-200",
  new: "bg-neutral-100 text-neutral-600 border-neutral-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
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
        {tickets?.map((t) => (
          <div key={t.id} className="rounded-lg border bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-neutral-400">
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
          <p className="p-6 text-center text-sm text-neutral-400">Queue is clear.</p>
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

function ApprovalsTab() {
  const { data: approvals } = useSWR<ApprovalRow[]>("/api/approvals", fetcher, POLL);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (id: string, decision: "approved" | "denied") => {
    setBusy(id);
    try {
      await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      await Promise.all([
        mutate("/api/approvals"),
        mutate("/api/tickets"),
        mutate("/api/audit"),
      ]);
    } finally {
      setBusy(null);
    }
  };

  const pending = approvals?.filter((a) => a.status === "pending") ?? [];
  const decided = approvals?.filter((a) => a.status !== "pending") ?? [];

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        {pending.length === 0 && (
          <p className="p-6 text-center text-sm text-neutral-400">
            Nothing waiting on you. Sensitive requests will land here.
          </p>
        )}
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
        {decided.length > 0 && (
          <>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Decided
            </p>
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
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b text-neutral-400">
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
                  <span className="text-neutral-400">/{e.actorId}</span>
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
                  className="py-1.5 font-mono text-neutral-300"
                  title={`hash: ${e.hash}\nEach hash covers the previous one — the chain breaks if history is edited.`}
                >
                  {e.hash.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

function PoliciesTab() {
  const { data: policies } = useSWR<PolicyRow[]>("/api/policies", fetcher, POLL);

  const toggle = async (id: string, enabled: boolean) => {
    await fetch(`/api/policies/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await Promise.all([mutate("/api/policies"), mutate("/api/audit")]);
  };

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        <p className="text-xs text-neutral-500">
          First matching rule wins, top to bottom. Toggle a rule and ask the agent again —
          its behavior changes instantly, because policy lives here, not in the model.
        </p>
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
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ---- shell -------------------------------------------------------------------

export function AdminConsole() {
  const { data: approvals } = useSWR<ApprovalRow[]>("/api/approvals", fetcher, POLL);
  const pendingCount = approvals?.filter((a) => a.status === "pending").length ?? 0;

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
          <TabsTrigger value="audit">Audit log</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
        </TabsList>
        <span className="text-xs text-neutral-400">IT console · Taylor Kim</span>
      </div>
      <TabsContent value="queue" className="min-h-0 flex-1">
        <QueueTab />
      </TabsContent>
      <TabsContent value="approvals" className="min-h-0 flex-1">
        <ApprovalsTab />
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
