"use client";

import { useState } from "react";
import useSWR from "swr";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface Persona {
  id: string;
  name: string;
  title: string;
  role: string;
}

interface TicketSummary {
  id: string;
  number: number;
  status: string;
  subject: string;
}

// ---- tool part rendering -------------------------------------------------

interface ToolPart {
  type: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface ActionOutcome {
  status: "completed" | "pending_approval" | "denied" | "failed";
  ticketNumber?: number;
  summary: string;
  policyApplied: string;
}

const TOOL_LABELS: Record<string, string> = {
  "tool-lookup_requester": "Looking up your profile and access",
  "tool-list_apps": "Checking the app catalog",
  "tool-preview_policy": "Checking policy",
  "tool-request_access": "Requesting access",
  "tool-reset_password": "Resetting password",
  "tool-provision_license": "Provisioning license",
};

const ACTION_TOOLS = new Set([
  "tool-request_access",
  "tool-reset_password",
  "tool-provision_license",
]);

function outcomeBadge(outcome: ActionOutcome) {
  const styles: Record<ActionOutcome["status"], string> = {
    completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    pending_approval: "bg-amber-50 text-amber-700 border-amber-200",
    denied: "bg-red-50 text-red-700 border-red-200",
    failed: "bg-red-50 text-red-700 border-red-200",
  };
  const labels: Record<ActionOutcome["status"], string> = {
    completed: "Done",
    pending_approval: "Awaiting IT approval",
    denied: "Denied by policy",
    failed: "Upstream failure",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${styles[outcome.status]}`}
    >
      {labels[outcome.status]}
      {outcome.ticketNumber ? ` · TKT-${outcome.ticketNumber}` : ""}
    </span>
  );
}

function TraceStep({ part }: { part: ToolPart }) {
  const label = TOOL_LABELS[part.type] ?? part.type.replace("tool-", "");
  const done = part.state === "output-available";
  const failed = part.state === "output-error";

  let extra: React.ReactNode = null;
  if (done && ACTION_TOOLS.has(part.type)) {
    const outcome = part.output as ActionOutcome;
    extra = (
      <div className="mt-1 flex flex-col gap-1">
        {outcomeBadge(outcome)}
        <span className="text-xs text-neutral-500">
          Policy: {outcome.policyApplied}
        </span>
      </div>
    );
  } else if (done && part.type === "tool-preview_policy") {
    const p = part.output as { outcome: string; rule: string };
    extra = (
      <span className="text-xs text-neutral-500">
        → {p.outcome.replace("_", " ")} · {p.rule}
      </span>
    );
  }

  return (
    <div className="flex items-start gap-2 py-0.5 pl-1 text-sm text-neutral-600">
      <span
        className="mt-0.5 text-xs"
        role="img"
        aria-label={failed ? "failed" : done ? "done" : "in progress"}
      >
        <span aria-hidden>
          {failed ? "✕" : done ? "✓" : <span className="animate-pulse">●</span>}
        </span>
      </span>
      <div>
        <span className={done || failed ? "" : "text-neutral-500"}>{label}</span>
        {extra}
        {failed && (
          <div className="text-xs text-red-600">{part.errorText ?? "Tool failed"}</div>
        )}
      </div>
    </div>
  );
}

// ---- message rendering ---------------------------------------------------

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-teal-600 px-3.5 py-2 text-sm text-white">
          {message.parts.map((part, i) =>
            part.type === "text" ? <span key={i}>{part.text}</span> : null,
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <div
              key={i}
              className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border bg-neutral-50 px-3.5 py-2 text-sm text-neutral-800"
            >
              {part.text}
            </div>
          );
        }
        if (part.type.startsWith("tool-")) {
          return <TraceStep key={i} part={part as unknown as ToolPart} />;
        }
        return null;
      })}
    </div>
  );
}

// ---- chat pane -----------------------------------------------------------

const SUGGESTIONS = [
  "I need access to Airtable",
  "Can I get editor on Figma?",
  "Reset my password please",
  "I need a Zoom license",
];

function ChatSession({ persona }: { persona: Persona }) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({ id: persona.id });

  const { data: tickets } = useSWR<TicketSummary[]>(
    `/api/tickets?requesterId=${persona.id}`,
    fetcher,
    { refreshInterval: 2000 },
  );

  const send = async (text: string) => {
    if (!text.trim() || status !== "ready") return;
    // Establish the signed session cookie for this persona before the chat request.
    // The server derives identity from the cookie, never from the message body.
    await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaId: persona.id }),
    });
    sendMessage({ text });
    setInput("");
  };

  const statusStyles: Record<string, string> = {
    solved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    pending_approval: "bg-amber-50 text-amber-700 border-amber-200",
    denied: "bg-red-50 text-red-700 border-red-200",
    in_progress: "bg-blue-50 text-blue-700 border-blue-200",
    new: "bg-neutral-50 text-neutral-600 border-neutral-200",
  };

  return (
    <>
      <ScrollArea className="min-h-0 flex-1 px-4 py-3">
        <div className="flex flex-col gap-3">
          {messages.length === 0 && (
            <div className="mt-6 text-center text-sm text-neutral-500">
              Ask IT anything — access, passwords, licenses.
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} />
          ))}
          {status === "submitted" && (
            <div className="pl-1 text-sm text-neutral-500">
              <span className="animate-pulse">Greenlight is thinking…</span>
            </div>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error.message.includes("api key") || error.message.includes("401")
                ? "Anthropic API key missing or invalid — set ANTHROPIC_API_KEY in .env and restart."
                : `Something broke: ${error.message}`}
            </div>
          )}
        </div>
      </ScrollArea>

      {(tickets?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t bg-neutral-50/60 px-4 py-2">
          {tickets!.slice(0, 4).map((t) => (
            <span
              key={t.id}
              title={t.subject}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyles[t.status] ?? statusStyles.new}`}
            >
              TKT-{t.number} · {t.status.replace("_", " ")}
            </span>
          ))}
        </div>
      )}

      <div className="border-t px-4 py-3">
        {messages.length === 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full border bg-white px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-teal-300 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message as ${persona.name.split(" ")[0]}…`}
            disabled={status !== "ready"}
          />
          <Button type="submit" disabled={status !== "ready" || !input.trim()}>
            Send
          </Button>
        </form>
      </div>
    </>
  );
}

export function EmployeeChat() {
  const { data: personas } = useSWR<Persona[]>("/api/personas", fetcher);
  const [personaId, setPersonaId] = useState<string>("jamie");
  const persona = personas?.find((p) => p.id === personaId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div>
          <div className="text-sm font-semibold">#it-help</div>
          <div className="text-xs text-neutral-500">
            {persona ? `${persona.name} · ${persona.title}` : "Loading…"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {personas?.map((p) => (
            <button
              key={p.id}
              onClick={() => setPersonaId(p.id)}
              title={`${p.name} — ${p.title} (${p.role})`}
              aria-pressed={p.id === personaId}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
                p.id === personaId
                  ? "border-teal-600 bg-teal-600 text-white"
                  : "bg-white text-neutral-600 hover:border-teal-300"
              }`}
            >
              {p.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>
      {persona ? (
        // Remount on persona switch: fresh conversation, fresh identity.
        <ChatSession key={persona.id} persona={persona} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
          Loading personas…
        </div>
      )}
      <div className="border-t bg-neutral-50 px-4 py-1.5 text-[11px] text-neutral-500">
        <Badge variant="outline" className="mr-2 border-neutral-200 text-[10px] font-normal text-neutral-500">
          demo note
        </Badge>
        Identity comes from the session, never the model. Policy is enforced server-side in the action layer.
      </div>
    </div>
  );
}
