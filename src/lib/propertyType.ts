// What the property-type dropdown on the onboarding confirm step should show
// before anyone touches it.
//
// RentCast returns the BUILDING's record for a street line (see parcelCacheKey
// in src/lib/parcel.ts), so a condo in a large mixed-use parcel comes back as
// "Apartment", which normalizePropertyType maps to multi_family. A tester who
// typed "204" in the unit box was therefore shown "Multi-family" for her
// condo. A unit number is the homeowner's own statement that this is one
// dwelling inside a building, and for a homeowner using this product that is
// a condo far more often than it is a multi-family property they own outright
// - so the unit wins over the provider's building-level guess.
//
// Only ever a DEFAULT. The dropdown is right there, and whatever is in it when
// the claim is pressed is what gets stored.
//
// Pure, no I/O, no React.

// The value the dropdown falls back to when nothing else is known - the same
// first option it has always shown.
export const FALLBACK_PROPERTY_TYPE = "single_family";

// Provider-derived types that describe a building rather than a dwelling, and
// so lose to an entered unit number.
const BUILDING_LEVEL_TYPES = new Set(["multi_family", "apartment"]);

export function defaultPropertyType(
  // The type the records lookup returned, already normalized to Hearth's enum
  // (or null when it returned nothing we recognize).
  factsType: string | null | undefined,
  // Does the homeowner's address carry a unit or apt number?
  hasUnit: boolean
): string {
  const fromFacts = (factsType ?? "").trim();
  if (hasUnit) {
    // Keep a specific unit-level answer the record actually gave (condo,
    // townhouse); replace a building-level one, or nothing at all.
    if (fromFacts && !BUILDING_LEVEL_TYPES.has(fromFacts)) return fromFacts;
    return "condo";
  }
  return fromFacts || FALLBACK_PROPERTY_TYPE;
}
