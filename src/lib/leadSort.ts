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

export type LeadSort = "new" | "fee";

// Newest is the default, and the order the RPC already returns.
//
// C5 (2026-09-07 tester wave): a "Biggest deal" sort used to sit next to this
// one, ordering by percent off. It competed with the "Cheapest fee" sort for
// the same job on the same tap - two different "this is the deal" pitches on
// one board read as confusing, not helpful, and "biggest deal" specifically
// spotlighted the free aging markdown over the paid OakTend Pro lead discount
// (the pricing priority per the growth research memory). "Cheapest fee" is
// kept: it is the discount-source-agnostic bottom line, so a Pro member's
// discounted price already sorts to the top under it without a second,
// competing button.
export const LEAD_SORT_OPTIONS: { value: LeadSort; label: string }[] = [
  { value: "new", label: "Newest" },
  { value: "fee", label: "Cheapest fee" },
];

/** Anything unknown (or missing) is the default order, never an error. */
export function normalizeLeadSort(value: string | undefined | null): LeadSort {
  return value === "fee" ? value : "new";
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
  return out;
}
