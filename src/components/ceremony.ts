// Pure helpers for the approve/accept "ceremony". Kept free of React/SWR imports
// so the placement logic can be unit-tested directly (see test/ceremony.test.ts)
// without a DOM. The 800ms hold must stay in sync with the gl-breathe cycle and
// the SWR poll interval (POLL.refreshInterval in admin-console.tsx).
export const CEREMONY_MS = 800;

/**
 * Split decision rows into the Pending and Decided columns, keeping a card that
 * is mid-ceremony pinned to Pending even after its status flips — otherwise the
 * 2.5s poll would yank it into Decided before the green hold finishes.
 *
 * The two lists are mutually exclusive and exhaustive for every (status,
 * celebrating) pairing, so each card renders in exactly one column: never both,
 * never neither.
 */
export function partitionByCeremony<T extends { id: string; status: string }>(
  rows: T[] | undefined,
  celebrating: string | null,
): { pending: T[]; decided: T[] } {
  const list = rows ?? [];
  return {
    pending: list.filter((r) => r.status === "pending" || r.id === celebrating),
    decided: list.filter((r) => r.status !== "pending" && r.id !== celebrating),
  };
}
