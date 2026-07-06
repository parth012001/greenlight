# Greenlight

**An IT agent that acts instantly when policy allows — and asks a human when it doesn't.**

A working sketch of approval-gated agent autonomy: an employee asks for access in chat, an AI agent resolves it end-to-end, and every consequential action passes through a policy engine, an approval queue, and a hash-chained audit log. Flip a policy toggle and the agent's behavior changes instantly — because policy lives in the action layer, not in the model.

## Run it

```bash
pnpm install
pnpm prisma db push && pnpm tsx prisma/seed.ts
echo 'ANTHROPIC_API_KEY="sk-ant-..."' >> .env   # chat needs this
pnpm dev                                        # → localhost:3000
```

Left pane: employee chat (pick a persona — their role changes what policy allows).
Right pane: the IT console — ticket queue, approval inbox, audit log, policy toggles.

**The demo moment:** ask for Airtable read-only as Jamie → instant. Ask for editor → lands in Approvals. Now disable "Read-only access: instant" in Policies and ask again — the same request now routes to a human. Same model, same prompt; only policy changed.

## Architecture decisions

- **The model proposes; the action layer decides.** Every tool that touches the world routes through `requestAction()` (`src/lib/actions.ts`): policy check → execute | queue approval | deny. The LLM is never trusted to enforce policy — its tools physically can't bypass the gate.
- **Identity comes from the session, never the model.** Tools are built per-request, scoped to the authenticated persona (`buildTools(requesterId)`). The model cannot act as someone else.
- **Connectors are an interface** (`src/lib/connectors/types.ts`). Sandbox implementations ship by default so the demo is deterministic — realistic latency, a failure-injection path, real state mutations against the Grant table. A real Okta/Google Admin implementation drops in behind the same contract without touching the agent or approval flow.
- **Audit log is hash-chained.** Each event's hash covers the previous event's hash (`src/lib/audit.ts`), so tampering with history is detectable. Audit events are written by the action layer, never the UI.
- **Idempotency keys** on actions guard against the model retrying a tool call — a duplicate request returns the original outcome instead of double-executing.
- **Policy is first-match-wins, default-closed.** Anything no rule speaks to goes to a human.

## Stack

Next.js (App Router) · TypeScript · Tailwind + shadcn/ui · Prisma (SQLite locally; schema kept enum-free so Postgres is a `DATABASE_URL` swap) · AI SDK v7 + Claude (`claude-opus-4-8`) · SWR polling for the live console (realtime push is the first production upgrade).

## What I'd build next

1. Realtime (Ably/WebSocket) instead of polling; notify the employee in-chat when their approval lands.
2. Autonomy graduation: after N clean approvals of the same action shape, propose promoting it to auto-approve — with the policy diff as the approval artifact.
3. Slack intake — same action layer, new front door.
4. One real connector (Okta dev org) behind the existing interface, to prove the seam.
