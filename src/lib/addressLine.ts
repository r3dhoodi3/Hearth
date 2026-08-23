// How a home's address reads to a human: the street line, plus the unit when
// there is one.
//
// Its own module, rather than living in src/lib/property.ts next to the
// queries, for one reason: this is the only address logic the BROWSER needs
// (the onboarding confirm step renders the full line as you type it), and
// property.ts imports next/headers and the Supabase server client, which a
// "use client" file cannot pull in. property.ts re-exports everything here, so
// server code can keep importing it from @/lib/property.
//
// Pure, no I/O, so it is also the piece that is actually unit-tested
// (./addressLine.test.ts).

// The shape formatAddressLine needs: the street line plus, since migration
// 0127, an optional unit. A structural type rather than the full Property row,
// so a caller holding a projection (a switcher summary, a lead's address
// snapshot, the onboarding form's in-progress values) can format an address
// without carrying a whole row.
//
// `unit` is optional AND nullable on purpose: a database that has not run 0127
// yet returns rows with no unit key at all, and this has to be exactly as
// happy with that as with an explicit null.
export type AddressLineParts = {
  address_line1: string;
  unit?: string | null;
};

// Unit designators someone might type into the unit box themselves. If the
// value already leads with one of these (or a "#"), it is a complete
// designator and gets appended as typed - "Apt 2" must never become
// "Unit Apt 2". Anything else is a bare identifier like "4B" and gets the word
// "Unit" put in front of it.
const UNIT_DESIGNATOR =
  /^(#|unit\b|apt\b|apartment\b|ste\b|suite\b|bldg\b|building\b|rm\b|room\b|lot\b|space\b|trlr\b|fl\b|floor\b|no\.?\b)/i;

// The ONLY place a unit gets joined to a street.
//
// address_line1 itself is never rewritten. It stays the street line that the
// RentCast lookup, the parcel cache key, and the assessor ownership match all
// run against (src/lib/parcel.ts), because a county record is filed under the
// street. Folding "Unit 4B" into it would quietly change what those lookups
// ask for. Display is a separate concern, so it gets a separate function.
export function formatAddressLine(property: AddressLineParts): string {
  const street = (property.address_line1 ?? "").trim();
  const unit = (property.unit ?? "").trim();
  if (!unit) return street;
  if (!street) return unit;
  return UNIT_DESIGNATOR.test(unit)
    ? `${street}, ${unit}`
    : `${street}, Unit ${unit}`;
}
