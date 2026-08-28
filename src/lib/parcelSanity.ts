// One gate for "that number is not about this home."
//
// RentCast matches /v1/properties on the STREET line and returns the base
// building record (see parcelCacheKey in src/lib/parcel.ts). For a condo or an
// apartment in a large mixed-use parcel that record describes the whole
// building, so its last sale price and its county assessment are the
// building's, not the unit's. A real tester at 1770 S Harbor Blvd Unit 204 in
// Anaheim was shown "Bought for $34,000,000 in 2017, down $33,201,000 since"
// under a $799,000 estimate on /value, and "County assessed value $36,410,541 /
// Prop 13 baseline $39,836,419" above a green "Your assessment looks in line"
// on /taxes. Both numbers were real county figures. Neither was about her home.
//
// So every screen that would print a purchase price or an assessed value runs
// it through here first, and every write that would store one does the same.
// There is no parcel_confidence column on properties yet (checked through
// migration 0139), so an implausible figure is simply not stored and not
// rendered rather than stored-and-flagged. Whenever a migration next touches
// properties, a real provenance column is the better home for this.
//
// Pure, no I/O, no React: server actions, server components and the browser
// all import it.

// A figure this far above the home's own estimate is not a bigger house, it is
// a different property. 10x is deliberately blunt: a genuinely under-assessed
// home, a 1970s purchase price against a 2026 estimate, and a Prop 13 baseline
// all sit well inside it.
export const IMPLAUSIBLE_ESTIMATE_MULTIPLE = 10;
// The floor under that multiple, so a home with no independent estimate on
// file (or a very cheap one) still has a ceiling. Nothing a single household
// buys through this product is $5M+, and the ones that are will have an
// estimate to be measured against.
export const IMPLAUSIBLE_FLOOR = 5_000_000;
// The absolute ceiling for a small home, applied whatever the property type
// says. A $25M+ figure attached to something under 5,000 sqft is a building,
// an assemblage or a bulk transfer, never that dwelling's own price.
export const ABSOLUTE_CEILING = 25_000_000;
export const SMALL_HOME_SQFT = 5_000;

// Property types whose county record is filed against a building rather than
// the dwelling. Normalized so RentCast's own wording ("Multi-Family",
// "Apartment") and Hearth's stored enum ("multi_family") both land here.
const BUILDING_LEVEL_TYPES = new Set([
  "condo",
  "condominium",
  "multi_family",
  "apartment",
]);

function normalizeType(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export type HomeFigureContext = {
  // The unit/apt designator the homeowner entered, if any. Its presence alone
  // means the county record for the street line is not this home's.
  unit?: string | null;
  // The home's property type, either Hearth's enum or the provider's wording.
  propertyType?: string | null;
  // Living area, used only by the absolute-ceiling rule.
  sqft?: number | null;
  // An estimate of this home's value that does NOT come from the figure being
  // judged - in practice the stored AVM, which is priced for the unit. Null
  // when there is none, which drops the test to IMPLAUSIBLE_FLOOR. Never pass
  // a value derived from the purchase price here: that would let a bad
  // purchase price raise its own ceiling.
  estimate?: number | null;
};

// Is this home one whose county record covers a building rather than the
// dwelling? A unit number OR a condo/multi-family property type.
export function isBuildingLevelHome(ctx: HomeFigureContext): boolean {
  if ((ctx.unit ?? "").trim().length > 0) return true;
  return BUILDING_LEVEL_TYPES.has(normalizeType(ctx.propertyType));
}

// The two rules, in one place:
//   1. A building-level home (a unit number, or a condo/multi-family type)
//      whose figure exceeds max(10x its own estimate, $5M).
//   2. Any figure over $25M on a home under 5,000 sqft, whatever its type.
// A missing or non-positive figure is never "implausible" - it is simply
// absent, which callers already handle.
export function isImplausibleHomeFigure(
  figure: number | null | undefined,
  ctx: HomeFigureContext
): boolean {
  if (typeof figure !== "number" || !Number.isFinite(figure) || figure <= 0) {
    return false;
  }

  if (isBuildingLevelHome(ctx)) {
    const estimate =
      typeof ctx.estimate === "number" && Number.isFinite(ctx.estimate) && ctx.estimate > 0
        ? ctx.estimate
        : 0;
    const ceiling = Math.max(estimate * IMPLAUSIBLE_ESTIMATE_MULTIPLE, IMPLAUSIBLE_FLOOR);
    if (figure > ceiling) return true;
  }

  // Deliberately requires a KNOWN sqft under the threshold. An unknown size is
  // not evidence of a small home, and this rule fires on the figure alone -
  // guessing here would hide a real number from an owner we know nothing about.
  const sqft = ctx.sqft;
  if (
    figure > ABSOLUTE_CEILING &&
    typeof sqft === "number" &&
    Number.isFinite(sqft) &&
    sqft > 0 &&
    sqft < SMALL_HOME_SQFT
  ) {
    return true;
  }

  return false;
}

// The figure when it survives the gate, null when it does not. The shape every
// caller actually wants: `const price = plausibleHomeFigure(raw, ctx)` reads
// the same as the old `const price = raw` and cannot be used without deciding.
export function plausibleHomeFigure(
  figure: number | null | undefined,
  ctx: HomeFigureContext
): number | null {
  if (typeof figure !== "number" || !Number.isFinite(figure)) return null;
  return isImplausibleHomeFigure(figure, ctx) ? null : figure;
}

// The one line shown where the number would have been. Says what happened,
// why, and what the homeowner can do about it, without naming a provider or
// blaming the county.
export const BUILDING_RECORD_NOTICE =
  "County records for this address cover the whole building, not your unit, so we can't show a purchase price or assessed value. You can add your own under Home details.";
