import type { ActionKind } from "@/lib/connectors/types";

// The action SHAPE — the exact (kind, appId, level, role) tuple evaluatePolicy
// matches on. Trust is earned per shape, never per agent; a graduated policy row
// is a maximally-narrow rule for one shape. Shared vocabulary for the trust
// engine (accounting) and the graduation engine (proposals) — lives here so
// neither has to import the other.

export interface ActionShape {
  kind: ActionKind;
  appId?: string | null;
  level?: string | null;
  role: string;
}

// "grant_access:airtable:editor:GTM" — "-" for absent parts. A computed string key
// because SQLite compound uniques don't enforce NULL uniqueness (idempotencyKey idiom).
export function shapeKeyOf(shape: ActionShape): string {
  return [shape.kind, shape.appId ?? "-", shape.level ?? "-", shape.role].join(":");
}

// Policy-id-safe slug: "grant-access-airtable-editor-gtm"
export function shapeKeySlug(shapeKey: string): string {
  return shapeKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function describeShape(shape: ActionShape, appName?: string): string {
  const app = appName ?? shape.appId ?? "";
  switch (shape.kind) {
    case "grant_access":
      return `${shape.role} · ${(shape.level ?? "").replace("_", "-")} access to ${app}`;
    case "revoke_access":
      return `${shape.role} · revoke access to ${app}`;
    case "reset_password":
      return `${shape.role} · password reset`;
    case "provision_license":
      return `${shape.role} · ${app} license`;
  }
}
