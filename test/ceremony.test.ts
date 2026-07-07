import { describe, it, expect } from "vitest";
import { partitionByCeremony } from "@/components/ceremony";

// The Pending/Decided partition is the most behaviorally significant part of the
// redesign: it decides which column a card renders in while its approve/accept
// ceremony holds. A pure helper lets us prove the invariant without a DOM.
describe("partitionByCeremony", () => {
  const rows = [
    { id: "a1", status: "pending" },
    { id: "a2", status: "approved" }, // just decided, mid-ceremony
    { id: "a3", status: "denied" },
  ];

  it("splits purely on status when nothing is celebrating", () => {
    const { pending, decided } = partitionByCeremony(rows, null);
    expect(pending.map((r) => r.id)).toEqual(["a1"]);
    expect(decided.map((r) => r.id)).toEqual(["a2", "a3"]);
  });

  it("pins a just-decided celebrating card to Pending and out of Decided", () => {
    // a2 has already flipped to "approved" (a mid-hold poll landed) but is still
    // celebrating — it must stay in Pending so the green rail isn't cut short.
    const { pending, decided } = partitionByCeremony(rows, "a2");
    expect(pending.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(decided.map((r) => r.id)).toEqual(["a3"]);
  });

  it("places every card in exactly one column for any (status, celebrating)", () => {
    for (const celebrating of [null, "a1", "a2", "a3", "does-not-exist"]) {
      const { pending, decided } = partitionByCeremony(rows, celebrating);
      // exhaustive: every row is placed somewhere
      const placed = [...pending, ...decided].map((r) => r.id).sort();
      expect(placed).toEqual(["a1", "a2", "a3"]);
      // mutually exclusive: no id appears in both columns
      const overlap = pending.filter((p) => decided.some((d) => d.id === p.id));
      expect(overlap).toEqual([]);
    }
  });

  it("treats undefined rows (SWR still loading) as empty", () => {
    expect(partitionByCeremony(undefined, null)).toEqual({
      pending: [],
      decided: [],
    });
    expect(partitionByCeremony(undefined, "a2")).toEqual({
      pending: [],
      decided: [],
    });
  });
});
