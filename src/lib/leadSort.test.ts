import { describe, expect, it } from "vitest";
import {
  LEAD_SORT_OPTIONS,
  normalizeLeadSort,
  sortLeads,
  type SortableLead,
} from "@/lib/leadSort";

// The comparators behind the three buttons on the leads board. They are shared
// by the server's first paint (src/app/pro/leads/page.tsx hands the board the
// order the URL asked for) and the client's instant re-sort
// (src/app/pro/leads/LeadsBoard.tsx), so this is the one place the rules live.

type Row = SortableLead & { id: string };

// Newest first, which is the order open_jobs_for_me already returns.
const rows: Row[] = [
  { id: "a", feeCents: 4500, off: 0 },
  { id: "b", feeCents: 1200, off: 40 },
  { id: "c", feeCents: 2500, off: 40 },
  { id: "d", feeCents: 900, off: 10 },
];
const ids = (r: Row[]) => r.map((x) => x.id);

describe("normalizeLeadSort", () => {
  it("accepts the two real sorts and defaults everything else to newest", () => {
    expect(normalizeLeadSort("fee")).toBe("fee");
    expect(normalizeLeadSort("deal")).toBe("deal");
    expect(normalizeLeadSort("new")).toBe("new");
    // A hand-typed or stale query string must never throw or blank the board.
    expect(normalizeLeadSort("cheapest")).toBe("new");
    expect(normalizeLeadSort("")).toBe("new");
    expect(normalizeLeadSort(undefined)).toBe("new");
    expect(normalizeLeadSort(null)).toBe("new");
  });
});

describe("sortLeads", () => {
  it("newest keeps the order it was given", () => {
    expect(ids(sortLeads(rows, "new"))).toEqual(["a", "b", "c", "d"]);
  });

  it("cheapest fee is ascending on the fee actually charged", () => {
    expect(ids(sortLeads(rows, "fee"))).toEqual(["d", "b", "c", "a"]);
  });

  it("biggest deal is the largest markdown first, cheapest breaking a tie", () => {
    // b and c are both 40% off, so the cheaper one leads.
    expect(ids(sortLeads(rows, "deal"))).toEqual(["b", "c", "d", "a"]);
  });

  it("never mutates or drops the caller's array", () => {
    const before = ids(rows);
    const sorted = sortLeads(rows, "fee");
    expect(ids(rows)).toEqual(before);
    expect(sorted).not.toBe(rows);
    expect(sorted).toHaveLength(rows.length);
  });

  it("is stable, so equal rows keep their newest-first order", () => {
    const tied: Row[] = [
      { id: "x", feeCents: 2000, off: 0 },
      { id: "y", feeCents: 2000, off: 0 },
      { id: "z", feeCents: 2000, off: 0 },
    ];
    expect(ids(sortLeads(tied, "fee"))).toEqual(["x", "y", "z"]);
    expect(ids(sortLeads(tied, "deal"))).toEqual(["x", "y", "z"]);
  });

  it("offers exactly the three buttons the board renders", () => {
    expect(LEAD_SORT_OPTIONS.map((o) => o.value)).toEqual([
      "new",
      "fee",
      "deal",
    ]);
    expect(LEAD_SORT_OPTIONS.map((o) => o.label)).toEqual([
      "Newest",
      "Cheapest fee",
      "Biggest deal",
    ]);
  });
});
