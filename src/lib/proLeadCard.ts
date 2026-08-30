import { isMajorCategory, MAJOR_INTRO_FEE } from "@/lib/constants";

// The pure display helpers a pro lead card is built from. They used to live
// inside src/app/pro/page.tsx, which was the only place that rendered a card.
// The Home / Leads tab split (2026-08-29) gave the "Asked for you" card a
// second home - a two-item preview on the pro Home tab - so the card moved to
// its own component (src/app/pro/DirectRequestCard.tsx) and these helpers moved
// here, where both the component and the leads board can import them. Nothing
// about the output changed; this is the same code in a shared file.
//
// Pure and import-light on purpose: no Supabase, no server-only, so a test can
// call these directly.

// Severity chip colours, keyed by the issue_severity a homeowner picked.
export const SEVERITY_STYLE: Record<string, string> = {
  low: "border-stone-200 bg-stone-50 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300",
  medium: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  urgent: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300",
};

export function money(n: number | string | null): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "-";
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

// The fee slot on a phone lead card's one-line glance. Normally the already-
// formatted price string; "Free" for an exact-zero fee, "New lead" as a
// defensive fallback if a fee could not be computed at all - LEAD_TIER_FEES
// never actually reaches zero today, but the glance line should never show a
// blank price.
export function feeGlanceLabel(fee: number, feeStr: string): string {
  if (!Number.isFinite(fee)) return "New lead";
  if (fee <= 0) return "Free";
  return feeStr;
}

// How long a job has been sitting open - shown on the card so a pro can see
// why an aging markdown exists (or that a listing is brand new).
export function postedAgo(createdAt: string | null | undefined): string | null {
  const t = new Date(createdAt ?? "").getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "Posted today";
  return `Posted ${days} day${days === 1 ? "" : "s"} ago`;
}

// Tiny factual signals a pro can price-judge a posting with. No scores, just
// whether the homeowner gave pros something real to go on. Freshness already
// shows via the posted-ago line, so it isn't repeated here.
export function qualityChips(j: any): string[] {
  const chips: string[] = [];
  // Major-tier jobs (roof/structural/remodeling) need real detail to bid
  // seriously - 80 characters of filler doesn't cut it at that price point,
  // so the floor doubles for those categories only (0114). Every other
  // category keeps the original 80.
  const detailFloor = isMajorCategory(j.category) ? 160 : 80;
  if ((j.issue_description ?? "").trim().length >= detailFloor)
    chips.push("Detailed description");
  // Photos are now shown as a thumbnail strip on the card, so no redundant
  // "Photos attached" chip; a job with photos but no rendered urls (rare) still
  // gets no chip - the strip is the signal now.
  if (j.timing) chips.push("Timing set");
  return chips;
}

// Major-tier project scope (0114): square footage and material notes, shown
// as the same muted chip tokens as budget/quality above. Only meaningful for
// roof/structural/remodeling jobs, and only when the homeowner actually filled
// them in - undefined until migration 0114 reaches the DB, which reads the
// same as "not provided" here.
export function scopeChips(j: any): string[] {
  const chips: string[] = [];
  if (!isMajorCategory(j.category)) return chips;
  const sqFt = Number(j.square_footage);
  if (Number.isFinite(sqFt) && sqFt > 0) {
    chips.push(`${sqFt.toLocaleString()} sq ft`);
  }
  const materials = typeof j.material_notes === "string" ? j.material_notes.trim() : "";
  if (materials) chips.push(materials);
  return chips;
}

// The intro price for a pro's FIRST paid big-ticket (major-tier) lead. It only
// undercuts the shown fee when it is actually lower: the DB charges
// least(aged fee, intro), so an aging markdown below $49.99 wins. Display-only;
// the DB re-derives this under the wallet lock at charge time (migration 0113).
export function introFeeFor(
  category: string,
  normalFee: number,
  hasPaidMajor: boolean
): number | null {
  return !hasPaidMajor && isMajorCategory(category) && MAJOR_INTRO_FEE < normalFee
    ? MAJOR_INTRO_FEE
    : null;
}
