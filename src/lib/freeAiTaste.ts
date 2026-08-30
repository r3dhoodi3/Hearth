// The two AI reads that used to be free AND unlimited, and now get a lifetime
// taste instead. This file is the PURE half: limits, column names, and the
// exact copy, with no imports at all, so a client component can render the
// meter and the paywall from the same strings the server sends. The database
// half lives in src/lib/freeAiTasteServer.ts, exactly the way askLimits.ts
// (client-safe) and aiUsage.ts (service-role) split the chat's meter.
//
// WHY THIS EXISTS. /api/extract-document (the document vault's AI read) and
// /api/ingest-inspection (the inspection report import) both called the paid
// model for a free account with no per-feature limit at all: the only thing
// behind them was the shared 25/day tool ceiling in aiUsage.ts, which exists
// to stop abuse, not to draw the line between free and Plus. So a free account
// could scan twenty-five documents a day, every day, forever, and the Plus
// story never mentioned it. Every other paid feature in the app already works
// the way this one now does: one real free use, then the door
// (users.free_quote_used_at, migration 0030; users.free_plan_used_at,
// migration 0101).
//
// THE SHAPE OF THE TASTE. Free gets 2 lifetime document reads and 1 lifetime
// inspection import. Plus and trialing accounts never touch these counters and
// stay bounded by the existing daily/burst/global ceilings.

export type FreeAiFeature = "document" | "inspection";

// Lifetime free reads, per feature, for an account with no Plus.
export const FREE_DOC_READS = 2;
export const FREE_INSPECTION_READS = 1;

export const FREE_TASTE_LIMIT: Record<FreeAiFeature, number> = {
  document: FREE_DOC_READS,
  inspection: FREE_INSPECTION_READS,
};

// The counter column each feature spends (migration 0135). Read directly for
// the meter; only ever written through claim_free_ai_taste /
// refund_free_ai_taste.
export const FREE_TASTE_COLUMN: Record<FreeAiFeature, string> = {
  document: "free_doc_reads_used",
  inspection: "free_inspection_reads_used",
};

// ONE copy for each refusal, sent by the route AND rendered by the component
// before the tap, so the screen never shows a message the server would not
// have sent, and a cold 402 never reaches anybody. Plain statement of fact
// plus what Plus adds, no urgency, matching the /plus?reason= banners.
export const FREE_TASTE_PAYWALL: Record<
  FreeAiFeature,
  { message: string; link: string }
> = {
  document: {
    message:
      "You've used your 2 free document reads. Plus reads every document you add, pulls out the brand, model, and warranty dates, and files it for you.",
    link: "/plus?reason=documents",
  },
  inspection: {
    message:
      "You've used your free inspection report read. Plus reads every report you add and turns it into your home's systems and issues.",
    link: "/plus?reason=inspection",
  },
};

// ---------------------------------------------------------------------------
// The pro side's taste (migration 0145)
// ---------------------------------------------------------------------------
// The AI back office (/pro/tools) was members-only with no way in at all: a pro
// was asked to pay for the idea of a draft. Same medicine as above, one level
// up - the counter belongs to the BUSINESS rather than the person, because the
// business is what has a membership and a wallet, so it lives on
// contractors.free_tool_drafts_used rather than on public.users. That is also
// why it is not part of FREE_TASTE_LIMIT / FREE_TASTE_COLUMN above: those two
// maps are keyed to columns on users and claim_free_ai_taste's feature names.
//
// Two, like the document read: enough to see a real estimate and a real
// invoice come out, which is the whole pitch.
export const FREE_PRO_DRAFTS = 2;

export const PRO_TOOLS_PAYWALL = {
  message: `You've used your ${FREE_PRO_DRAFTS} free drafts. Hearth Pro includes unlimited drafts: estimates, invoices, follow-ups, review responses, and overdue reminders.`,
  link: "/pro/plus?reason=tools",
};

// The meter a non-member sees BEFORE they tap, never after the fact. Same rule
// as tasteMeterLabel above: state the exact number and unit in front of the
// button.
export function proDraftMeterLabel(left: number): string {
  if (left <= 0) return "No free drafts left";
  return `${left} of ${FREE_PRO_DRAFTS} free drafts left`;
}

// The quote analyzer's one free check is older than this file and lives in its
// own column (users.free_quote_used_at, migration 0030), so it is not part of
// FREE_TASTE_PAYWALL above. Its refusal copy belongs here anyway: the repeat
// attempt used to come back as a bare "This feature is part of Hearth Plus.",
// the one cold, benefit-free wall in the app, hit at the exact moment somebody
// has a second contractor bid in their hand. Same voice as the
// /plus?reason=quote banner, and shared by the route and the component so the
// two can never drift.
export const QUOTE_TASTE_PAYWALL = {
  message:
    "You've used your free quote check. Plus reads every quote, flags padding, and writes the negotiation message.",
  link: "/plus?reason=quote",
};

// The meter a free account sees BEFORE it taps, never after the fact: state
// the exact number and unit, in front of the button, the way Ask Hearth's
// "N of 3 free questions left today" does. Pure, so the copy is testable
// without a database. `left` is what is actually left.
export function tasteMeterLabel(feature: FreeAiFeature, left: number): string {
  if (feature === "inspection") {
    return left === 1
      ? "1 free inspection read"
      : `${left} free inspection reads`;
  }
  return `${left} of ${FREE_DOC_READS} free reads left`;
}
