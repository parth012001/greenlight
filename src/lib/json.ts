// Defensive JSON.parse for values read back out of the database. A single malformed
// or legacy row must not throw and take down an entire list endpoint (audit, approvals),
// so parse failures return the caller's fallback instead of propagating.
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
