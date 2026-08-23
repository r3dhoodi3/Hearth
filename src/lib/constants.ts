// Shared option lists. Keep these in sync with the CHECK comments in the schema.


// =============================================================================
// COLD START: launch-phase liquidity levers.
//
// While the marketplace is young, both sides of it are opened up to build
// liquidity: homeowners post jobs free (no Plus requirement, no free-post cap)
// and EVERY pro gets instant new-job alerts (not just Pro members). Flip each
// constant to false to restore the Plus posting gate and the members-only
// instant alerts; every consumer references these constants and keeps the
// original gate code intact behind them, so reverting is a one-line change.
//
// These flags never touch the quality guards (auth, the 20-character job
// description floor, duplicate-post protection): those stay on regardless.
// =============================================================================
export const COLD_START_FREE_POSTING = true;
export const COLD_START_FREE_ALERTS = true;

// =============================================================================
// AI GLOBAL SPEND BREAKER: an owner-wide, all-users-combined daily ceiling on
// the paid model routes (Claude, via src/lib/claude.ts), enforced in
// src/lib/aiUsage.ts on top of the per-user daily cap. This is NOT a per-user
// limit: it is one shared bucket across every account, a runaway-cost circuit
// breaker so no volume of free signups can fan the daily model bill past a
// hard number. Set well ABOVE realistic total
// daily usage (across every route and every user) so legitimate traffic never
// trips it, but low enough that a cost-abuse spike hits a wall. If real usage
// ever approaches this, raise it deliberately rather than letting it silently
// throttle everyone. Counted once per request through the shared rate_limit_hit
// RPC (migration 0068) under this fixed bucket, on an 86400s (daily) window.
// =============================================================================
export const AI_GLOBAL_DAILY_LIMIT = 5000;
export const AI_GLOBAL_BUCKET = "ai-global-day";

// =============================================================================
// FOUNDER: owner-fillable identity for the /pros landing page's "Who's behind
// this" section. Left blank on purpose: fill these in with real details, do
// not invent a name, city, or phone number. When name is blank the page falls
// back to an honest generic line instead of a placeholder like "Jane Doe".
// =============================================================================
export const FOUNDER = {
  name: "Landen Chu",
  // Second founder, credited alongside `name` in the founder copy. Blank it
  // out and the pages drop back to single-founder wording on their own.
  coFounder: "William Tran",
  // Not currently rendered in the founder copy (the landing and /pros pages
  // say "homeowners in Orange County" instead); kept for future use.
  city: "Fountain Valley",
  cellPhone: "",
  // Public contact email for prospective pros (shown on /pros). The in-app
  // help page needs an account, so signed-out visitors need SOME reachable
  // channel. Real, monitored inbox; if it ever goes unmonitored, blank it
  // out and the pages simply show no contact link rather than a dead one.
  //
  // TODO(legal): this is the founder's PERSONAL inbox, chosen as the contact
  // for now. It also becomes the published contact on the legal pages
  // (/privacy, /terms, /ai-disclosure) via LegalContact, which means the
  // arbitration opt-out and dispute-notice deadlines run against it. Two
  // lawyers flagged routing legal notices to a personal Gmail as an
  // operational risk; move to a monitored business inbox before launch.
  email: "landenchu2000@gmail.com",
};

export const SYSTEM_TYPES = [
  { value: "roof", label: "Roof"},
  { value: "hvac", label: "HVAC"},
  { value: "water_heater", label: "Water heater"},
  { value: "electrical_panel", label: "Electrical panel"},
  { value: "plumbing", label: "Plumbing"},
  { value: "windows", label: "Windows"},
  { value: "foundation", label: "Foundation"},
  { value: "appliance", label: "Major appliance"},
  { value: "gutters", label: "Gutters"},
  { value: "siding", label: "Siding"},
  { value: "garage_door", label: "Garage door"},
  { value: "deck", label: "Deck / patio"},
  { value: "driveway", label: "Driveway"},
  { value: "sump_pump", label: "Sump pump"},
  { value: "sewer_line", label: "Sewer / septic"},
  { value: "fence", label: "Fence"},
] as const;

// Example Brand / Model values shown as PLACEHOLDERS in the walkthrough's
// manual-entry step (src/app/(app)/walkthrough/SystemCaptureCard.tsx), one per
// SYSTEM_TYPES value.
//
// This exists because both fields used to show the same water-heater example
// ("e.g. Rheem", "e.g. XE50T10H45U0") for every system, so an owner standing
// at their roof, panel, or driveway was being shown a model number off a water
// heater and had to guess what shape of answer the box wanted. A placeholder's
// whole job is to show the shape of the answer, and the wrong example does
// that job backwards.
//
// An EMPTY string means "this system has no brand or model" (a foundation, a
// poured driveway): the card renders "Not applicable" rather than inventing an
// example. Keep one entry per SYSTEM_TYPES value; the test in
// src/lib/systemFieldExamples.test.ts fails if a type is missing.
//
// Keep every example SHORT. These render inside a half-width box in a two
// column grid, so on a 390px phone anything past roughly a dozen characters is
// simply cut off mid-word ("e.g. Duration sh"), and a hint you cannot finish
// reading is worse than a shorter one that lands.
export type SystemFieldExample = { brand: string; model: string };

export const SYSTEM_FIELD_EXAMPLES: Record<string, SystemFieldExample> = {
  roof: { brand: "Owens Corning", model: "Duration" },
  hvac: { brand: "Carrier", model: "24ACC636" },
  water_heater: { brand: "Rheem", model: "XE50T10H45U0" },
  electrical_panel: { brand: "Square D", model: "QO130M200" },
  // Whole-house plumbing has no plate to read: what matters is the pipe.
  plumbing: { brand: "", model: "Copper pipe" },
  windows: { brand: "Andersen", model: "400 Series" },
  foundation: { brand: "", model: "" },
  appliance: { brand: "Bosch", model: "SHPM65Z55N" },
  gutters: { brand: "", model: "Aluminum, 5 in" },
  siding: { brand: "James Hardie", model: "HardiePlank" },
  garage_door: { brand: "LiftMaster", model: "8550W" },
  deck: { brand: "Trex", model: "Transcend" },
  driveway: { brand: "", model: "Concrete" },
  sump_pump: { brand: "Zoeller", model: "M53" },
  sewer_line: { brand: "", model: "ABS to main" },
  fence: { brand: "", model: "Cedar, 6 ft" },
};

// The examples for one system type. An unknown type (a value added to the DB
// ahead of this list) falls back to no example at all rather than to some
// other system's, which is the bug this whole map exists to fix.
export function systemFieldExample(
  systemType: string | null | undefined
): SystemFieldExample {
  return SYSTEM_FIELD_EXAMPLES[systemType ?? ""] ?? { brand: "", model: "" };
}

// Marker text the auto-seeded starter inventory used to use as a per-system
// note. We no longer store it (the notice lives at the top of the profile),
// but we still filter it out so older auto-added rows display cleanly.
export const STARTER_SYSTEM_NOTE =
  "Auto-added from your address. Update the year if you know it.";

// Home-problem categories for the issue tracker (home-health side). These are
// things that go *wrong* with a house, not every service a pro offers.
export const ISSUE_CATEGORIES = [
  { value: "roof", label: "Roof"},
  { value: "plumbing", label: "Plumbing"},
  { value: "electrical", label: "Electrical"},
  { value: "hvac", label: "HVAC"},
  { value: "structural", label: "Structural"},
  { value: "other", label: "Other"},
] as const;

// Canonical service categories a contractor advertises and a homeowner can post
// a job in. Must stay in sync with the contractor CategoryPicker. A job's
// category is matched (exact equality) against contractors.categories, so both
// sides have to draw from this same list. (Custom "Other" services are handled
// separately as free text.)
export const SERVICE_CATEGORIES = [
  { value: "roof", label: "Roof"},
  { value: "plumbing", label: "Plumbing"},
  { value: "electrical", label: "Electrical"},
  { value: "hvac", label: "HVAC"},
  { value: "structural", label: "Structural"},
  { value: "remodeling", label: "Remodeling"},
  { value: "landscaping", label: "Landscaping"},
  { value: "cleaning", label: "Cleaning"},
  { value: "windows", label: "Windows"},
  { value: "painting", label: "Painting"},
  { value: "home_inspection", label: "Home inspection"},
  { value: "pest", label: "Pest & termite control"},
  { value: "garage_door", label: "Garage door"},
  { value: "handyman", label: "Handyman"},
] as const;

// Every value a job's category can take, for labels/icons when displaying a
// posted job (the canonical services plus the catch-all "Other" bucket).
export const JOB_CATEGORIES = [
  ...SERVICE_CATEGORIES,
  { value: "other", label: "Other"},
] as const;

// Per-category "what to shoot" lists shown next to the photo picker when a
// homeowner posts a job or reports an issue. Keyed by JOB_CATEGORIES values
// (ISSUE_CATEGORIES values are a subset, so both forms share this list). Text
// only, on purpose: a concrete shot list of THEIR house teaches better than a
// stock photo of someone else's, and hotlinked example images rot or carry
// licensing risk. Keep each list at 2-4 short lines so it stays scannable.
export const PHOTO_TIPS: Record<string, string[]> = {
  plumbing: [
    "A close-up of the leak or drip itself",
    "One step back showing the whole fixture or pipe",
    "The shutoff valve for that fixture",
    "Any water damage or staining around it",
  ],
  structural: [
    "The crack up close, with a coin or tape measure for scale",
    "A wide shot of the whole wall or slab",
    "Where the crack meets the floor or ceiling",
    "Any nearby doors or windows that stick",
  ],
  roof: [
    "The problem area from the ground, zoomed in if you can",
    "The gutter line and roof edge",
    "A ceiling stain inside, if there is one",
  ],
  electrical: [
    "The breaker panel with the door open",
    "The outlet, switch, or fixture in question",
    "Any scorch marks or discoloration, up close",
  ],
  hvac: [
    "The unit's label plate with the model number",
    "The whole unit, indoor and outdoor if you have both",
    "The thermostat showing its current reading",
  ],
  windows: [
    "The damage up close",
    "The whole window or door from inside",
    "The same window or door from outside",
  ],
  remodeling: [
    "The whole room or area from a corner",
    "Each wall or surface you want changed",
    "Anything staying put that pros will work around",
  ],
  landscaping: [
    "A wide shot of the whole yard or area",
    "The specific spots that need work, up close",
    "Access points like gates or side yards",
  ],
  cleaning: [
    "The rooms or areas that need the most attention",
    "Any problem spots like stains or buildup, up close",
  ],
  painting: [
    "The whole wall or surface in daylight",
    "Peeling, cracking, or stains up close",
    "Trim, ceilings, or doors if they're included",
  ],
  home_inspection: [
    "The front of the house from the street",
    "Any specific spots you're worried about",
    "The attic or crawl space entrance, if you know where it is",
  ],
  pest: [
    "The pests or droppings you've found, up close",
    "Any damage, like chewed wood or wiring",
    "Where they seem to be getting in, if you've spotted it",
  ],
  garage_door: [
    "The whole door from outside",
    "The opener unit and its label",
    "The damaged section, track, or spring up close",
  ],
  handyman: [
    "Each item on your list, one photo per fix",
    "A step back showing where each one lives",
  ],
  other: [
    "The problem up close",
    "A step back showing the whole area",
    "Anything a pro would need to bring the right parts",
  ],
};

export function photoTipsFor(category: string): string[] {
  return PHOTO_TIPS[category] ?? PHOTO_TIPS.other;
}

// Popular remodel / improvement projects we surface as recommendations.
// `category` maps each project to the contractor category used for matching.
export const REMODEL_PROJECTS = [
  { label: "Kitchen remodel", category: "remodeling" },
  { label: "Bathroom remodel", category: "remodeling" },
  { label: "Window replacement", category: "windows" },
  { label: "Stairs & railings", category: "structural" },
  { label: "Flooring", category: "remodeling" },
  { label: "Deck / patio", category: "structural" },
  { label: "Interior painting", category: "painting" },
  { label: "Garage door", category: "garage_door" },
  { label: "Roof replacement", category: "roof" },
  { label: "Panel upgrade", category: "electrical" },
  { label: "HVAC install", category: "hvac" },
  { label: "Water heater", category: "plumbing" },
  { label: "Solar panels", category: "electrical" },
  { label: "Fencing", category: "landscaping" },
  { label: "Landscaping", category: "landscaping" },
  { label: "Driveway / concrete", category: "structural" },
  { label: "Siding", category: "structural" },
  { label: "Gutter installation", category: "roof" },
  { label: "Insulation", category: "remodeling" },
  { label: "Basement finishing", category: "remodeling" },
  { label: "Smart home / security", category: "electrical" },
  { label: "Drywall repair", category: "remodeling" },
] as const;

export const SEVERITIES = [
  { value: "low", label: "Low. Keep an eye on it." },
  { value: "medium", label: "Medium. Should be addressed soon." },
  { value: "urgent", label: "Urgent. Needs a pro now." },
] as const;

export const PROPERTY_TYPES = [
  { value: "single_family", label: "Single family" },
  { value: "condo", label: "Condo" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multi-family" },
  { value: "other", label: "Other" },
] as const;

export const TIMING_OPTIONS = [
  { value: "asap", label: "As soon as possible" },
  { value: "few_weeks", label: "Within a few weeks" },
  { value: "flexible", label: "I'm flexible" },
] as const;

// Rough budget bands a homeowner can attach to a job posting. Purely a signal
// so pros can quote realistically, never a commitment or a binding number.
// Keep the values in sync with the column comment on
// contractor_leads.budget_range (supabase/migrations/0050_job_budget.sql).
export const BUDGET_RANGES = [
  { value: "under-500", label: "Under $500" },
  { value: "500-1500", label: "$500-1,500" },
  { value: "1500-5000", label: "$1,500-5,000" },
  { value: "5000-15000", label: "$5,000-15,000" },
  { value: "15000-25000", label: "$15,000 - $25,000" },
  { value: "25000-50000", label: "$25,000 - $50,000" },
  { value: "50000-plus", label: "$50,000+" },
  { value: "not-sure", label: "Not sure yet" },
] as const;

// Per-lead fee (USD) a pro owes to unlock/apply for a lead, by category.
//
// Priced in three tiers keyed to job value + what a pro can bear (a lead is only
// worth a slice of the expected job profit). Benchmarked below the big lead
// marketplaces (Angi $15-85+/lead plus a ~$300/yr fee; Thumbtack ~$20-75) so
// Hearth undercuts them, with no annual fee:
//   Tier 1  $25  light / low-ticket work (cleaning, landscaping, painting,
//                handyman)
//   Tier 2  $50  skilled trades + replacements (plumbing, electrical, HVAC,
//                windows, garage door, pest & termite control)
//   Tier 3  $99  big-ticket (roofing, structural, remodeling / general contracting)
export const LEAD_TIER_FEES = { light: 25, skilled: 50, major: 99 } as const;

// First-timer intro price for the major tier: a pro's FIRST big-ticket lead
// ever costs this, every major-tier lead after that costs the normal
// LEAD_TIER_FEES.major. The authoritative check and charge live in the DB
// (apply_to_lead / unlock_direct_request, migration 0113), which decides
// "first" from the pro's own payment history under the wallet lock; this
// constant only drives display copy and the board's price preview. Keep in
// sync with major_lead_price_cents() in 0113 (4999 cents).
export const MAJOR_INTRO_FEE = 49.99;

export const LEAD_FEES: Record<string, number> = {
  // Tier 3 - major
  roof: LEAD_TIER_FEES.major,
  structural: LEAD_TIER_FEES.major,
  remodeling: LEAD_TIER_FEES.major,
  // Tier 2 - skilled
  hvac: LEAD_TIER_FEES.skilled,
  plumbing: LEAD_TIER_FEES.skilled,
  electrical: LEAD_TIER_FEES.skilled,
  windows: LEAD_TIER_FEES.skilled,
  home_inspection: LEAD_TIER_FEES.skilled,
  garage_door: LEAD_TIER_FEES.skilled,
  pest: LEAD_TIER_FEES.skilled,
  // Tier 1 - light
  landscaping: LEAD_TIER_FEES.light,
  cleaning: LEAD_TIER_FEES.light,
  painting: LEAD_TIER_FEES.light,
  handyman: LEAD_TIER_FEES.light,
  other: LEAD_TIER_FEES.light,
};

export function leadFeeFor(category: string): number {
  return LEAD_FEES[category] ?? LEAD_FEES.other;
}

// Whether a category bills at the major (big-ticket) tier. Derived from
// LEAD_FEES so it can never drift from the fee map; mirrored by the hardcoded
// category list in migration 0113 (major_lead_price_cents).
export function isMajorCategory(category: string): boolean {
  return LEAD_FEES[category] === LEAD_TIER_FEES.major;
}

// Hearth Pro membership (contractor side) pricing, USD. This is the ONE place
// the prices live: the /pro/plus page and checkout both read from here, so a
// price change is a one-line edit. Every brand-new Pro subscriber, on either
// cadence, gets a trialDays free trial (a Stripe trial, so the card is
// collected up front but nothing is charged until it ends). Membership is
// perks only: it never gates lead access. Every pro sees every job and pays
// per application, member or not.
export const PRO_PLAN = {
  monthly: 29.99,
  // 12 x 19.99: the yearly plan works out to exactly $19.99/mo, a real $120
  // saving vs paying monthly. Always compare against monthly x 12 in copy,
  // never an invented list price.
  yearly: 239.88,
  trialDays: 3,
  // RETIRED while trialDays is on, kept only so the number stays in one place
  // if it is ever brought back. The old offer was a first month at this price
  // via a one-time $20-off Stripe coupon, and it CANNOT coexist with the free
  // trial: Stripe considers a duration:"once" coupon used "after the invoice
  // finalizes", and a trial start finalizes a $0 invoice, so the coupon would
  // be burned on the $0 invoice and the first real bill would silently be full
  // price - more than the buyer was shown. startProCheckoutAction therefore
  // only attaches the coupon when the checkout carries no trial, which today
  // is never. Nothing that quotes a price to a buyer reads this.
  introFirstMonth: 9.99,
} as const;

// Hearth Plus membership (homeowner side) pricing, USD. Same role PRO_PLAN
// plays for the contractor side: the ONE place the homeowner prices live, so
// the /plus page, the checkout action, the auto-renewal disclosure in
// src/lib/billingTerms.ts, and the renewal-reminder cron can never quote a
// price the card isn't actually charged. Every brand-new subscriber, on any
// cadence (MONTHLY only since 2026-08-23), gets a 3-day free trial (a Stripe trial, so nothing is charged
// until it ends); yearly is also discounted on top of that.
export const PLUS_PLAN = {
  // GRANDFATHERED ONLY, no longer sold. Weekly was retired as a new-checkout
  // option (only monthly and yearly are sold now), but existing weekly
  // subscribers keep their plan, so the price stays here: the auto-renewal
  // disclosure in src/lib/billingTerms.ts and the renewal-reminder cron still
  // need it to quote a legacy weekly row correctly. Nothing new-checkout reads
  // it - startPlusCheckoutAction only offers monthly/yearly.
  weekly: 1.99,
  monthly: 4.99,
  // 33% off monthly x 12 ($59.88), about $3.33/mo. Always compare against
  // monthly x 12 in copy, never an invented list price.
  yearly: 39.99,
  trialDays: 3,
} as const;

// =============================================================================
// PLAN MATH: derived helpers only. Every number below is COMPUTED from the
// PLUS_PLAN / PRO_PLAN prices above, so a price edit moves the pricing pages
// with it and no page can hardcode a saving, an annual total, or a per-day
// figure that a card is not actually charged.
//
// The house rule these exist to enforce: an annual plan is only ever compared
// against twelve charges at the real monthly price, never against an invented
// list price. yearlyRunRate() IS that anchor.
// =============================================================================

type PlanPrices = { monthly: number; yearly: number };

// Money as a display string, always two decimals, so $4.99 never renders as
// "4.9" and a computed $120 never renders as "$120".
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Cent-accurate rounding. Plain float math on prices drifts (4.99 * 12 is
// 59.88000000000001 in IEEE 754), and a drifting cent in a price line is a
// disclosure problem, not a cosmetic one.
function toCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// What twelve months at the monthly price actually costs. The only honest
// anchor for the yearly plan.
export function yearlyRunRate(plan: PlanPrices): number {
  return toCents(plan.monthly * 12);
}

// Dollars saved by paying yearly instead of twelve monthly charges. Positive
// whenever yearly is the better deal; the pages only render it when it is.
export function yearlySavings(plan: PlanPrices): number {
  return toCents(yearlyRunRate(plan) - plan.yearly);
}

// The yearly price spread across a 365-day year, rounded UP to the next cent.
// Rounding up is deliberate: a per-day line must never quote less than the
// plan costs. The toFixed(6) pass absorbs float noise so a price that divides
// evenly into cents does not get pushed a cent higher by 1e-15.
export function perDayFromYearly(yearly: number): number {
  const cents = (yearly / 365) * 100;
  return Math.ceil(Number(cents.toFixed(6))) / 100;
}

// The per-day cost of the yearly plan, e.g. "about $0.11 a day".
export function yearlyPerDay(plan: Pick<PlanPrices, "yearly">): number {
  return perDayFromYearly(plan.yearly);
}

// The per-day cost of staying on monthly for a full year (monthly x 12 spread
// over 365 days). Same arithmetic, applied to the honest annual run rate.
export function monthlyPerDay(plan: Pick<PlanPrices, "monthly">): number {
  return perDayFromYearly(toCents(plan.monthly * 12));
}

// The yearly plan re-expressed as a monthly figure, e.g. "about $3.33/mo".
export function yearlyAsMonthly(plan: Pick<PlanPrices, "yearly">): number {
  return toCents(plan.yearly / 12);
}

// =============================================================================
// THE TWO PLUS ALLOWANCES THE MARKETING COPY QUOTES OUT LOUD.
//
// Both used to be typed into the /plus card by hand ("Up to 5 homes", "15
// questions a day"), which is the one place a number is guaranteed to go stale
// without anyone noticing: the card is copy, and copy is not what anybody
// re-reads when they change a limit. A wrong number here is a promise the
// product does not keep.
// =============================================================================

// Homes included with Plus, before any paid extra-home slots. Read by the cap
// in claimPropertyAction (src/app/onboarding/actions.ts), which is the check
// that actually enforces it, and by the /plus card that advertises it. The DB
// backstop in supabase/migrations/0108_extra_home_slots.sql has to agree on
// the same number.
export const PLUS_INCLUDED_HOMES = 5;

// Ask Hearth questions a day on Plus. MIRRORS ASK_DAILY_PLUS in
// src/lib/aiUsage.ts, which is the value the server actually enforces and
// cannot be imported here: aiUsage.ts pulls in the service-role Supabase
// client, which is "server-only" and fails the build the moment a client
// component (the /plus card) imports it. src/lib/constants.test.ts reads
// aiUsage.ts's source and fails if the two ever disagree, so the mirror can
// never quietly drift.
export const PLUS_ASK_PER_DAY = 15;

// Pay-per-extra-home add-on (Plus members only). The ONE place the add-on
// pricing lives, so the /plus "More homes" UI, the setExtraHomesAction server
// action's inline price_data fallback, and the recurring-total disclosure can
// never quote a number the card isn't charged. Volume (tiered) pricing: the
// discounted unit price applies to ALL purchased slots once the quantity
// crosses a tier breakpoint (Stripe "volume" tiers, not "graduated"). Free
// homeowners hitting the cap get the Plus upsell instead; Plus already
// includes up to 5 homes, and these are extra homes on top of that.
export const EXTRA_HOME = {
  // Max extra homes a member can buy on top of the 5 Plus includes.
  maxExtra: 20,
  // Per-slot unit price by billing interval, in USD. Each entry is a volume
  // tier: `upTo` is the highest quantity (inclusive) that pays this unit
  // price; once quantity exceeds it, the next tier's unit price applies to
  // EVERY slot. The last tier's `upTo` is null (no upper bound below maxExtra).
  // Ordered ascending by breakpoint; keep in sync with the Stripe dashboard
  // volume Price tiers (STRIPE_PRICE_HOME_SLOT_MONTHLY / _YEARLY).
  monthly: [
    { upTo: 2, unit: 1.99 },
    { upTo: 4, unit: 1.49 },
    { upTo: null as number | null, unit: 0.99 },
  ],
  yearly: [
    { upTo: 2, unit: 14.99 },
    { upTo: 4, unit: 11.99 },
    { upTo: null as number | null, unit: 7.99 },
  ],
} as const;

// The per-slot unit price for a given quantity and interval, applying the
// volume discount to ALL slots (see EXTRA_HOME). Quantity 0 returns the
// first-tier price (nothing is charged at 0 anyway). Single source of truth
// for both the UI's shown price and the inline price_data fallback amount.
export function extraHomeUnitPrice(
  interval: "monthly" | "yearly",
  quantity: number
): number {
  const tiers = EXTRA_HOME[interval];
  for (const tier of tiers) {
    if (tier.upTo === null || quantity <= tier.upTo) return tier.unit;
  }
  // Unreachable: the last tier's upTo is null. Fall back to the last unit.
  return tiers[tiers.length - 1].unit;
}

// Extra percentage points a Pro member earns on top of the deposit-bonus tier
// percentage, applied to every deposit. Display-side mirror of the
// p_bonus_boost_pts argument the Stripe webhook passes to apply_deposit
// (supabase/migrations/0035_pro_membership.sql).
export const PRO_DEPOSIT_BOOST_PTS = 5;

// Applicant cap: this many live (non-refunded) applications fill a posted job,
// so pros stop burning fees on crowded postings. Must match the check in
// apply_to_lead (supabase/migrations/0031_ghost_protection.sql).
export const MAX_APPLICANTS_PER_JOB = 3;

// Earn-in for the Hearth-funded Checkr background check. Every check costs
// Hearth real money, so it unlocks after the pro has this many PAID lead
// applications (lead_applications rows with refunded_at null - a refunded
// application was never a paid lead). Mirrored in the gate inside
// startBackgroundCheckAction and in the progress line on BackgroundCheckCard,
// so the copy and the check can never quote different numbers.
export const BACKGROUND_CHECK_MIN_PAID_LEADS = 3;

// Ghost protection: an application the homeowner never responds to gets its
// fee back as wallet credit after this many days (credit only, never cash).
// Display-only mirror of the cron window in
// supabase/migrations/0031_ghost_protection.sql.
export const GHOST_PROTECTION_DAYS = 7;

// Default lifetime (days) of granted bonus credit. Display-only mirror of the
// DEFAULT on wallet_config.bonus_expiry_days
// (supabase/migrations/0010_wallet_v2.sql). Every grant path still reads the
// live wallet_config value in SQL, so this only keeps default-case copy (e.g.
// the credit-back notification) from quoting a number the config could have
// been tuned away from; if that row is ever changed, update this too.
export const BONUS_EXPIRY_DAYS = 60;

// Maps a home system to the contractor category, so a "Find a pro" button on a
// system jumps straight to the right trade.
export const SYSTEM_CATEGORY: Record<string, string> = {
  roof: "roof",
  hvac: "hvac",
  water_heater: "plumbing",
  electrical_panel: "electrical",
  plumbing: "plumbing",
  windows: "structural",
  foundation: "structural",
  appliance: "other",
  gutters: "roof",
  siding: "structural",
  garage_door: "garage_door",
  deck: "structural",
  driveway: "other",
  sump_pump: "plumbing",
  sewer_line: "plumbing",
  fence: "structural",
};

export function categoryForSystem(systemType: string): string {
  return SYSTEM_CATEGORY[systemType] ?? "other";
}

// Equipment systems ask for a make / model (brand); structural systems ask for
// a material. Everything else falls back to a generic "Material / model" label.
const MAKE_MODEL_SYSTEMS = new Set([
  "hvac",
  "water_heater",
  "electrical_panel",
  "appliance",
  "garage_door",
  "sump_pump",
]);

export function materialLabel(systemType: string): string {
  return MAKE_MODEL_SYSTEMS.has(systemType) ? "Make / model" : "Material";
}

// Dropdown options when adding or editing a system: brands for equipment,
// materials for structural systems. "Other" (added in the picker) lets an owner
// type something not listed.
export const SYSTEM_MATERIALS: Record<string, string[]> = {
  // --- material-based (structural) ---
  roof: [
    "Asphalt shingle",
    "Architectural shingle",
    "Metal",
    "Clay / concrete tile",
    "Slate",
    "Wood shake",
    "Flat - TPO",
    "Flat - EPDM rubber",
  ],
  plumbing: [
    "Copper",
    "PEX",
    "CPVC",
    "PVC",
    "Galvanized steel (older)",
    "Cast iron",
  ],
  windows: [
    "Vinyl",
    "Wood",
    "Aluminum",
    "Fiberglass",
    "Composite",
    "Single pane",
    "Double pane",
    "Triple pane",
  ],
  foundation: [
    "Poured concrete",
    "Concrete block",
    "Slab",
    "Crawl space",
    "Basement",
    "Pier & beam",
  ],
  gutters: ["Aluminum", "Vinyl", "Copper", "Steel", "Seamless aluminum"],
  siding: [
    "Vinyl",
    "Fiber cement (Hardie)",
    "Wood",
    "Aluminum",
    "Brick",
    "Stucco",
    "Stone veneer",
  ],
  deck: [
    "Pressure-treated wood",
    "Cedar",
    "Redwood",
    "Composite (Trex)",
    "PVC",
    "Hardwood",
  ],
  driveway: ["Concrete", "Asphalt", "Pavers", "Gravel", "Brick"],
  sewer_line: [
    "PVC",
    "Cast iron",
    "Clay",
    "ABS",
    "Orangeburg (older)",
    "Septic tank",
  ],
  fence: ["Wood", "Vinyl", "Chain link", "Aluminum", "Wrought iron", "Composite"],
  // --- make / model (equipment brands) ---
  hvac: [
    "Carrier",
    "Trane",
    "Lennox",
    "Goodman",
    "Rheem",
    "York",
    "American Standard",
    "Bryant",
  ],
  water_heater: [
    "Rheem",
    "A.O. Smith",
    "Bradford White",
    "Rinnai (tankless)",
    "Navien (tankless)",
    "Bosch",
    "State",
  ],
  electrical_panel: [
    "Square D",
    "Eaton / Cutler-Hammer",
    "Siemens",
    "General Electric",
    "Federal Pacific (older)",
    "Zinsco (older)",
  ],
  appliance: [
    "Whirlpool",
    "GE",
    "Samsung",
    "LG",
    "Bosch",
    "Maytag",
    "Frigidaire",
    "KitchenAid",
    "Kenmore",
  ],
  garage_door: [
    "Clopay",
    "Wayne Dalton",
    "Amarr",
    "Overhead Door",
    "LiftMaster",
    "Genie",
    "Chamberlain",
  ],
  sump_pump: [
    "Zoeller",
    "Wayne",
    "Liberty",
    "Basement Watchdog",
    "Superior Pump",
  ],
};

export function materialsForSystem(systemType: string): string[] {
  return SYSTEM_MATERIALS[systemType] ?? [];
}

// A short, plain maintenance tip per system, shown when an owner expands a
// system for details. Keeps the advice useful without needing a pro.
export const SYSTEM_TIPS: Record<string, string> = {
  roof: "Have it inspected after big storms and keep the valleys and flashing clear of debris.",
  hvac: "Swap the filter every few months and book a tune up before summer and winter.",
  water_heater:
    "Flush the tank once a year to clear sediment and check the anode rod every few years.",
  electrical_panel:
    "Watch for breakers that trip often or warm cover plates and have any of those checked.",
  plumbing:
    "Know where your main shutoff is and look under sinks now and then for slow leaks.",
  windows:
    "Reseal worn caulk and weatherstripping so you keep the heat and cool air inside.",
  foundation:
    "Keep soil sloped away from the house and watch for new cracks or sticking doors.",
  appliance:
    "Clean the coils and filters and keep the manual handy so repairs stay simple.",
  gutters:
    "Clear them at least twice a year so water drains away from the roof and foundation.",
  siding:
    "Rinse it yearly and touch up paint or sealant so moisture cannot get behind it.",
  garage_door:
    "Test the auto reverse safety feature and oil the rollers and hinges once a year.",
  deck: "Check for loose boards and rusted fasteners and reseal the wood every couple of years.",
  driveway:
    "Seal cracks before winter so water cannot freeze, expand, and widen them.",
  sump_pump:
    "Pour in a bucket of water a few times a year to confirm it kicks on before a storm does.",
  sewer_line:
    "Avoid flushing grease or wipes and consider a camera inspection if drains run slow.",
  fence: "Reset leaning posts early and seal the wood so it does not rot at the base.",
};

export function tipForSystem(systemType: string): string {
  return (
    SYSTEM_TIPS[systemType] ??
    "Give it a look now and then and note anything that seems worn so small fixes stay small."
  );
}

// Lead lifecycle on the contractor side.
export const LEAD_STATUSES = [
  { value: "new", label: "New" },
  { value: "accepted", label: "Accepted" },
  { value: "closed", label: "Closed (won)" },
  { value: "lost", label: "Declined" },
] as const;

export function labelFor(
  list: readonly { value: string; label: string }[],
  value: string | null | undefined
): string {
  if (!value) return "-";
  // Unknown values (legacy rows, options removed from a list) must never leak
  // as raw enums like "this_month" - humanize the underscores as a fallback.
  return list.find((o) => o.value === value)?.label ?? value.replace(/_/g, " ");
}

// Short seasonal maintenance checklist, shown on Home for the current season.
export const SEASONAL_TASKS: Record<string, string[]> = {
  spring: [
    "Book an HVAC tune-up before summer.",
    "Clear gutters of winter debris.",
    "Inspect the roof for winter damage.",
    "Test the sprinkler / irrigation system.",
  ],
  summer: [
    "Replace or clean the AC filter.",
    "Reseal the deck and check for loose boards.",
    "Rinse the siding and check for damage.",
    "Check window screens and weatherstripping.",
  ],
  fall: [
    "Clean the gutters before the rains.",
    "Book a furnace / heating tune-up.",
    "Drain and shut off outdoor faucets.",
    "Test the sump pump before storm season.",
  ],
  winter: [
    "Check for drafts around windows and doors.",
    "Watch the roof for ice dams after storms.",
    "Test smoke and carbon monoxide detectors.",
    "Know where your main water shutoff is.",
  ],
};

// Calendar month (0-11) to season.
export function seasonForMonth(month: number): keyof typeof SEASONAL_TASKS {
  if (month === 11 || month <= 1) return "winter";
  if (month <= 4) return "spring";
  if (month <= 7) return "summer";
  return "fall";
}
