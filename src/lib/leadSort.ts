// The leads-board sort: one pure module so the server's first paint and the
// client's instant re-sort can never disagree about what "Cheapest fee" means.
//
// WHY IT MOVED HERE (2026-08-30). The three buttons used to be links to
// /pro/leads?sort=..., so every tap was a full server navigation: the whole
// page re-queried Supabase, re-rendered and re-streamed just to reorder a list
// the browser already had. On a phone that reads as a lag and, when a tap
// landed twice, as a bug. The rows arrive in the board as plain props, so the
// reorder is a comparator over an array the client is already holding.
//
// The board still receives the sort the URL asked for and renders that order
// on the server, so a shared or reloaded /pro/leads?sort=fee link paints
// sorted, with no flash of the wrong order.

export type LeadSort = "new" | "fee" | "deal";

// Newest is the default, and the order the RPC already returns.
export const LEAD_SORT_OPTIONS: { value: LeadSort; label: string }[] = [
  { value: "new", label: "Newest" },
  { value: "fee", label: "Cheapest fee" },
  { value: "deal", label: "Biggest deal" },
];

/** Anything unknown (or missing) is the default order, never an error. */
export function normalizeLeadSort(value: string | undefined | null): LeadSort {
  return value === "fee" || value === "deal" ? value : "new";
}

// The only two numbers a sort reads. Both are already resolved on the server
// (the aging markdown and the one-time intro price both read the clock), so
// the client re-sorts finished values rather than recomputing prices.
export type SortableLead = {
  /** Effective apply fee in cents: what this pro would actually be charged. */
  feeCents: number;
  /** Aging-deal percent off, 0 when the listing is still fresh. */
  off: number;
};

/**
 * A new array in the asked-for order. Never mutates the input: the "Newest"
 * order is the order the caller passed in, so the board keeps that array
 * intact to switch back to.
 */
export function sortLeads<T extends SortableLead>(
  rows: readonly T[],
  sort: LeadSort
): T[] {
  const out = rows.slice();
  // Cheapest first, by the fee actually charged - which is the number printed
  // on the card, including the first-big-ticket intro price. The server used
  // to sort by the pre-intro fee, so a discounted card could sit below a
  // dearer one under "Cheapest fee".
  if (sort === "fee") out.sort((a, b) => a.feeCents - b.feeCents);
  // Biggest markdown first, cheapest breaking a tie.
  else if (sort === "deal")
    out.sort((a, b) => b.off - a.off || a.feeCents - b.feeCents);
  return out;
}
