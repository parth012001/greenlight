# Greenlight

**An IT agent that acts instantly when policy allows, asks a human when it doesn't, and earns broader autonomy only after it proves itself.**

A working sketch of approval-gated agent autonomy: an employee asks for access in chat, an AI agent resolves it end-to-end, and every consequential action passes through a policy engine, an approval queue, and a hash-chained audit log. Flip a policy toggle and the agent's behavior changes instantly — because policy lives in the action layer, not in the model. And trust is earned per action shape: after a track record of clean approvals, the system proposes promoting that exact shape to auto-approve, then revokes it the moment an autonomous run goes wrong.

## Run it

```bash
pnpm install
pnpm prisma migrate dev && pnpm tsx prisma/seed.ts
echo 'ANTHROPIC_API_KEY="sk-ant-..."' >> .env   # chat needs this
pnpm dev                                        # → localhost:3000
```

Left pane: employee chat (pick a persona — their role changes what policy allows).
Right pane: the IT console — ticket queue, approval inbox, **Trust ledger**, audit log, policy toggles.

## Two demo moments

**Policy is live, not baked into the model.** Ask for Airtable read-only as Jamie → instant. Ask for editor → lands in Approvals. Now disable "Read-only access: instant" in Policies and ask again — the same request routes to a human. Same model, same prompt; only policy changed.

**Trust is earned, then losable.** Approve Jamie's Airtable-editor request a third time and a graduation proposal pops in Approvals — a policy diff plus a replay of recent actions proving only that exact shape flips. Accept it, and the next identical ask auto-approves with the graduated rule in its trace. Flip the app's "Simulate outage" switch and ask again: the autonomous run fails, autonomy is revoked on the spot, and the shape is back to requiring a human. Every step lands on the audit chain.

## Architecture decisions

- **The model proposes; the action layer decides.** Every tool that touches the world routes through `requestAction()` (`src/lib/actions.ts`): policy check → execute | queue approval | deny. The LLM is never trusted to enforce policy — its tools physically can't bypass the gate.
- **Identity comes from the session, never the model.** Tools are built per-request, scoped to the authenticated persona (`buildTools(requesterId)`). The model cannot act as someone else.
- **Trust is a property of the action shape, not the agent.** A shape is the exact `(kind, appId, level, role)` tuple the policy engine matches on. Streaks accrue per shape, and a graduated rule is maximally narrow, so autonomy earned by one shape can never widen to another. Promotion is by evidence window, never calendar; demotion is one genuinely bad run, re-earned in full. (`src/lib/trust.ts`, `src/lib/graduation.ts`)
- **Connectors are an interface** (`src/lib/connectors/types.ts`). Sandbox implementations ship by default so the demo is deterministic — realistic latency, a failure-injection path, real state mutations against the Grant table. A real Okta/Google Admin implementation drops in behind the same contract without touching the agent or approval flow.
- **Audit log is hash-chained.** Each event's hash covers the previous event's hash (`src/lib/audit.ts`), so tampering with history is detectable. Audit events are written by the action layer, never the UI.
- **Idempotency keys** on actions guard against the model retrying a tool call — a duplicate request returns the original outcome instead of double-executing.
- **Policy is first-match-wins, default-closed.** Anything no rule speaks to goes to a human.

## Stack

Next.js (App Router) · TypeScript · Tailwind + shadcn/ui · Prisma (SQLite locally; schema kept enum-free so Postgres is a `DATABASE_URL` swap) · AI SDK v7 + Claude (`claude-opus-4-8`) · SWR polling for the live console (realtime push is the first production upgrade).

## What's next

- **Okta connector.** One real connector behind the existing `Connector` interface — provision and deprovision against an Okta dev org — to prove the sandbox seam holds against a real system of record. The agent, policy engine, approval flow, and trust ledger don't change; only the connector implementation does.
- **Slack intake.** Same action layer, a new front door: request access from a Slack slash command or DM, with approvals delivered as Slack interactive messages. The gate doesn't move — only the surface does.

## What I'm deliberately not doing (yet)

- **Realtime push.** The console polls on a 2.5s interval. It's honest for a demo, and the graduation card still pops on the same tick as the approval that earned it. Realtime (WebSocket/Ably) plus in-chat "your request landed" notifications is the first production upgrade, not a demo requirement.
- **A second LLM to "double-check" the agent.** Safety here comes from the deterministic action layer, not from stacking models. A reviewer model would blur where trust actually lives.
- **Auto-widening trust.** Graduation only ever produces a single-shape rule. There is intentionally no "promote the whole role or app" path — that would trade the thing that makes earned autonomy safe for convenience.
- **Calendar-based promotion.** No "trusted after 30 days." Promotion is evidence-driven or it doesn't happen.
