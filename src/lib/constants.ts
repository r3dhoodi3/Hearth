// Shared option lists. Keep these in sync with the CHECK comments in the schema.

import type { LucideIcon } from "lucide-react";
import {
  Home,
  Wind,
  ShowerHead,
  Zap,
  Wrench,
  AppWindow,
  Building2,
  Plug,
  CloudRain,
  Layers,
  DoorOpen,
  Trees,
  Route,
  Droplet,
  Toilet,
  Fence as FenceIcon,
  HelpCircle,
  Hammer,
  Leaf,
  SprayCan,
  Paintbrush,
  Search,
  Bug,
  HardHat,
  ChefHat,
  Bath,
  MoveVertical,
  Grid3x3,
  Sun,
  Thermometer,
  Camera,
  Boxes,
  Blocks,
} from "lucide-react";

// One icon per category value, shared across every list below that uses the
// same value (e.g. "roof" gets the same icon in SYSTEM_TYPES and
// SERVICE_CATEGORIES). Keeping this in one map means a category always reads
// the same everywhere it appears.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  roof: Home,
  hvac: Wind,
  water_heater: ShowerHead,
  electrical_panel: Zap,
  plumbing: Wrench,
  windows: AppWindow,
  foundation: Building2,
  appliance: Plug,
  gutters: CloudRain,
  siding: Layers,
  garage_door: DoorOpen,
  deck: Trees,
  driveway: Route,
  sump_pump: Droplet,
  sewer_line: Toilet,
  fence: FenceIcon,
  electrical: Zap,
  structural: Building2,
  other: HelpCircle,
  remodeling: Hammer,
  landscaping: Leaf,
  cleaning: SprayCan,
  painting: Paintbrush,
  home_inspection: Search,
  pest: Bug,
  handyman: HardHat,
};

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
// the paid Gemini routes, enforced in src/lib/aiUsage.ts on top of the per-user
// daily cap. This is NOT a per-user limit: it is one shared bucket across every
// account, a runaway-cost circuit breaker so no volume of free signups can fan
// the daily Gemini bill past a hard number. Set well ABOVE realistic total
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
  { value: "roof", label: "Roof", icon: CATEGORY_ICONS.roof },
  { value: "hvac", label: "HVAC", icon: CATEGORY_ICONS.hvac },
  { value: "water_heater", label: "Water heater", icon: CATEGORY_ICONS.water_heater },
  { value: "electrical_panel", label: "Electrical panel", icon: CATEGORY_ICONS.electrical_panel },
  { value: "plumbing", label: "Plumbing", icon: CATEGORY_ICONS.plumbing },
  { value: "windows", label: "Windows", icon: CATEGORY_ICONS.windows },
  { value: "foundation", label: "Foundation", icon: CATEGORY_ICONS.foundation },
  { value: "appliance", label: "Major appliance", icon: CATEGORY_ICONS.appliance },
  { value: "gutters", label: "Gutters", icon: CATEGORY_ICONS.gutters },
  { value: "siding", label: "Siding", icon: CATEGORY_ICONS.siding },
  { value: "garage_door", label: "Garage door", icon: CATEGORY_ICONS.garage_door },
  { value: "deck", label: "Deck / patio", icon: CATEGORY_ICONS.deck },
  { value: "driveway", label: "Driveway", icon: CATEGORY_ICONS.driveway },
  { value: "sump_pump", label: "Sump pump", icon: CATEGORY_ICONS.sump_pump },
  { value: "sewer_line", label: "Sewer / septic", icon: CATEGORY_ICONS.sewer_line },
  { value: "fence", label: "Fence", icon: CATEGORY_ICONS.fence },
] as const;

// Marker text the auto-seeded starter inventory used to use as a per-system
// note. We no longer store it (the notice lives at the top of the profile),
// but we still filter it out so older auto-added rows display cleanly.
export const STARTER_SYSTEM_NOTE =
  "Auto-added from your address. Update the year if you know it.";

// Home-problem categories for the issue tracker (home-health side). These are
// things that go *wrong* with a house, not every service a pro offers.
export const ISSUE_CATEGORIES = [
  { value: "roof", label: "Roof", icon: CATEGORY_ICONS.roof },
  { value: "plumbing", label: "Plumbing", icon: CATEGORY_ICONS.plumbing },
  { value: "electrical", label: "Electrical", icon: CATEGORY_ICONS.electrical },
  { value: "hvac", label: "HVAC", icon: CATEGORY_ICONS.hvac },
  { value: "structural", label: "Structural", icon: CATEGORY_ICONS.structural },
  { value: "other", label: "Other", icon: CATEGORY_ICONS.other },
] as const;

// Canonical service categories a contractor advertises and a homeowner can post
// a job in. Must stay in sync with the contractor CategoryPicker. A job's
// category is matched (exact equality) against contractors.categories, so both
// sides have to draw from this same list. (Custom "Other" services are handled
// separately as free text.)
export const SERVICE_CATEGORIES = [
  { value: "roof", label: "Roof", icon: CATEGORY_ICONS.roof },
  { value: "plumbing", label: "Plumbing", icon: CATEGORY_ICONS.plumbing },
  { value: "electrical", label: "Electrical", icon: CATEGORY_ICONS.electrical },
  { value: "hvac", label: "HVAC", icon: CATEGORY_ICONS.hvac },
  { value: "structural", label: "Structural", icon: CATEGORY_ICONS.structural },
  { value: "remodeling", label: "Remodeling", icon: CATEGORY_ICONS.remodeling },
  { value: "landscaping", label: "Landscaping", icon: CATEGORY_ICONS.landscaping },
  { value: "cleaning", label: "Cleaning", icon: CATEGORY_ICONS.cleaning },
  { value: "windows", label: "Windows", icon: CATEGORY_ICONS.windows },
  { value: "painting", label: "Painting", icon: CATEGORY_ICONS.painting },
  { value: "home_inspection", label: "Home inspection", icon: CATEGORY_ICONS.home_inspection },
  { value: "pest", label: "Pest & termite control", icon: CATEGORY_ICONS.pest },
  { value: "garage_door", label: "Garage door", icon: CATEGORY_ICONS.garage_door },
  { value: "handyman", label: "Handyman", icon: CATEGORY_ICONS.handyman },
] as const;

// Every value a job's category can take, for labels/icons when displaying a
// posted job (the canonical services plus the catch-all "Other" bucket).
export const JOB_CATEGORIES = [
  ...SERVICE_CATEGORIES,
  { value: "other", label: "Other", icon: CATEGORY_ICONS.other },
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
  { label: "Kitchen remodel", icon: ChefHat, category: "remodeling" },
  { label: "Bathroom remodel", icon: Bath, category: "remodeling" },
  { label: "Window replacement", icon: AppWindow, category: "windows" },
  { label: "Stairs & railings", icon: MoveVertical, category: "structural" },
  { label: "Flooring", icon: Grid3x3, category: "remodeling" },
  { label: "Deck / patio", icon: Trees, category: "structural" },
  { label: "Interior painting", icon: Paintbrush, category: "painting" },
  { label: "Garage door", icon: DoorOpen, category: "garage_door" },
  { label: "Roof replacement", icon: Home, category: "roof" },
  { label: "Panel upgrade", icon: Zap, category: "electrical" },
  { label: "HVAC install", icon: Wind, category: "hvac" },
  { label: "Water heater", icon: ShowerHead, category: "plumbing" },
  { label: "Solar panels", icon: Sun, category: "electrical" },
  { label: "Fencing", icon: FenceIcon, category: "landscaping" },
  { label: "Landscaping", icon: Leaf, category: "landscaping" },
  { label: "Driveway / concrete", icon: Route, category: "structural" },
  { label: "Siding", icon: Layers, category: "structural" },
  { label: "Gutter installation", icon: CloudRain, category: "roof" },
  { label: "Insulation", icon: Thermometer, category: "remodeling" },
  { label: "Basement finishing", icon: Boxes, category: "remodeling" },
  { label: "Smart home / security", icon: Camera, category: "electrical" },
  { label: "Drywall repair", icon: Blocks, category: "remodeling" },
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
// contractor_leads.budget_range (supabase/migrations/0047_job_budget.sql).
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
// cadence, gets a 3-day free trial (a Stripe trial, so nothing is charged
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
// (supabase/migrations/0032_pro_membership.sql).
export const PRO_DEPOSIT_BOOST_PTS = 5;

// Applicant cap: this many live (non-refunded) applications fill a posted job,
// so pros stop burning fees on crowded postings. Must match the check in
// apply_to_lead (supabase/migrations/0028_ghost_protection.sql).
export const MAX_APPLICANTS_PER_JOB = 3;

// Ghost protection: an application the homeowner never responds to gets its
// fee back as wallet credit after this many days (credit only, never cash).
// Display-only mirror of the cron window in
// supabase/migrations/0028_ghost_protection.sql.
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

export function iconFor(
  list: readonly { value: string; icon?: LucideIcon }[],
  value: string | null | undefined
): LucideIcon | null {
  if (!value) return null;
  return list.find((o) => o.value === value)?.icon ?? null;
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
