// The integration seam. Agent tools and the action layer only ever talk to this
// interface — sandbox implementations ship by default so the demo is deterministic,
// and a real implementation (Okta API, Google Admin SDK) drops in behind the same
// contract without touching the agent or the approval flow.

export type ActionKind =
  | "grant_access"
  | "revoke_access"
  | "reset_password"
  | "provision_license";

export type ConnectorAction =
  | { kind: "grant_access"; userId: string; appId: string; level: string }
  | { kind: "revoke_access"; userId: string; appId: string }
  | { kind: "reset_password"; userId: string }
  | { kind: "provision_license"; userId: string; appId: string };

export interface ConnectorResult {
  ok: boolean;
  /** Human-readable outcome, shown in tickets and the audit log. */
  summary: string;
  /** Upstream reference, e.g. a sandbox group membership id. */
  externalRef?: string;
  error?: string;
}

export interface Connector {
  key: string;
  displayName: string;
  execute(action: ConnectorAction): Promise<ConnectorResult>;
}
