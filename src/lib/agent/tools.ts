import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { evaluatePolicy } from "@/lib/policy";
import { requestAction } from "@/lib/actions";
import type { ActionKind } from "@/lib/connectors/types";

// Tools are scoped to the authenticated requester (factory closure) — the model
// cannot act as anyone else. Every consequential tool routes through
// requestAction(), where policy is enforced server-side.

export function buildTools(requesterId: string) {
  return {
    lookup_requester: tool({
      description:
        "Look up the current requester: profile, role, and the access they already have. Call this first on every conversation.",
      inputSchema: z.object({}),
      execute: async () => {
        const user = await prisma.user.findUniqueOrThrow({
          where: { id: requesterId },
          include: {
            grants: { where: { revokedAt: null }, include: { app: true } },
          },
        });
        return {
          name: user.name,
          title: user.title,
          role: user.role,
          email: user.email,
          currentAccess: user.grants.map((g) => ({
            app: g.app.name,
            appId: g.appId,
            level: g.level,
          })),
        };
      },
    }),

    list_apps: tool({
      description:
        "List the apps Greenlight can act on, with available access levels and seat usage.",
      inputSchema: z.object({}),
      execute: async () => {
        const apps = await prisma.app.findMany({ orderBy: { name: "asc" } });
        return apps.map((a) => ({
          appId: a.id,
          name: a.name,
          levels: a.levels.split(","),
          seats: `${a.seatsUsed}/${a.seatsTotal}`,
        }));
      },
    }),

    preview_policy: tool({
      description:
        "Preview what policy would decide for an action WITHOUT executing it: instant (auto-approve), needs human approval, or denied. Use it to set expectations before acting.",
      inputSchema: z.object({
        kind: z.enum([
          "grant_access",
          "revoke_access",
          "reset_password",
          "provision_license",
        ]),
        appId: z.string().optional().describe("App slug from list_apps, e.g. 'airtable'"),
        level: z.string().optional().describe("Access level, e.g. 'read_only' or 'editor'"),
      }),
      execute: async ({ kind, appId, level }) => {
        const user = await prisma.user.findUniqueOrThrow({ where: { id: requesterId } });
        const decision = await evaluatePolicy({
          kind: kind as ActionKind,
          appId,
          level,
          role: user.role,
        });
        return {
          outcome: decision.effect,
          rule: decision.policyName,
        };
      },
    }),

    request_access: tool({
      description:
        "Request app access for the requester. Creates a ticket and either provisions instantly, routes to IT for approval, or is denied — per policy. Returns the real outcome.",
      inputSchema: z.object({
        appId: z.string().describe("App slug from list_apps"),
        level: z.string().describe("Access level, e.g. 'read_only' or 'editor'"),
        justification: z
          .string()
          .describe("Why the requester needs this, in their words"),
      }),
      execute: async ({ appId, level, justification }) =>
        requestAction({
          requesterId,
          kind: "grant_access",
          appId,
          level,
          justification,
        }),
    }),

    reset_password: tool({
      description:
        "Reset the requester's own password (sends a reset link to their email and clears active sessions). Creates a ticket; policy decides if it runs instantly.",
      inputSchema: z.object({
        justification: z.string().describe("Why, e.g. 'locked out after MFA change'"),
      }),
      execute: async ({ justification }) =>
        requestAction({ requesterId, kind: "reset_password", justification }),
    }),

    provision_license: tool({
      description:
        "Assign a paid license/seat (e.g. Zoom) to the requester. Creates a ticket; policy decides if it runs instantly.",
      inputSchema: z.object({
        appId: z.string().describe("App slug from list_apps"),
        justification: z.string(),
      }),
      execute: async ({ appId, justification }) =>
        requestAction({
          requesterId,
          kind: "provision_license",
          appId,
          justification,
        }),
    }),
  };
}
