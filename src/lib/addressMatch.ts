// Is the county's street line the same address the homeowner picked?
//
// The onboarding confirm step used to overwrite the street box with whatever
// the records lookup returned, silently. A tester picked "1770 South Harbor
// Boulevard" from the autocomplete list and every screen after it - the claim
// step, the dashboard, /value, /taxes - read "2170 S Harbor Blvd", with no
// notice that anything had been swapped. RentCast matched a neighbouring
// parcel and the form treated that as a correction.
//
// So the picked address is now what gets displayed and claimed, and this
// module answers the one question the confirm step needs: does the record we
// found actually describe the address they picked? House number and street
// tokens have to agree; the unit is ignored, because the record is filed
// against the street either way (see parcelCacheKey in src/lib/parcel.ts).
//
// Pure, no I/O, no React: the client form and the server action both use it.

// Directionals and street types, normalized to one spelling each so "South
// Harbor Boulevard" and "S Harbor Blvd" compare equal. USPS abbreviations,
// which is what county records and Photon both tend toward.
const TOKEN_ALIASES: Record<string, string> = {
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
  street: "st",
  avenue: "ave",
  av: "ave",
  boulevard: "blvd",
  road: "rd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  circle: "cir",
  place: "pl",
  terrace: "ter",
  parkway: "pkwy",
  highway: "hwy",
  trail: "trl",
  square: "sq",
  loop: "loop",
  way: "way",
};

// Unit designators. Everything from one of these to the end of the line is
// dropped: a designator is always trailing on a US address line, and its
// identifier ("204", "4B") is exactly the part that must not count.
const UNIT_DESIGNATORS = new Set([
  "unit",
  "apt",
  "apartment",
  "ste",
  "suite",
  "bldg",
  "building",
  "rm",
  "room",
  "lot",
  "space",
  "spc",
  "trlr",
  "fl",
  "floor",
  "no",
  "num",
]);

function tokenize(line: string): string[] {
  return (line ?? "")
    .toLowerCase()
    // "#204" and "Unit 204" mean the same thing; make the marker a token.
    .replace(/#/g, " unit ")
    .replace(/[.,]/g, " ")
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// The house number: the leading numeric token, kept as a string so "0123" and
// "123" stay distinguishable and a hyphenated number ("12-14") survives whole.
// Null when the line does not start with one.
export function houseNumberOf(line: string): string | null {
  const first = tokenize(line)[0];
  if (!first) return null;
  return /^\d+[a-z0-9-]*$/.test(first) ? first : null;
}

// The street tokens after the house number, with the unit designator and
// everything after it removed and each remaining token canonicalized.
export function streetTokensOf(line: string): string[] {
  const tokens = tokenize(line);
  const start = houseNumberOf(line) != null ? 1 : 0;
  const out: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (UNIT_DESIGNATORS.has(t)) break;
    out.push(TOKEN_ALIASES[t] ?? t);
  }
  return out;
}

// Do these two address lines describe the same street address? House number
// equal AND street tokens equal, unit ignored on both sides.
//
// Two lines with NO house number on either side fall back to comparing the
// street tokens alone, which is the honest reading of a rural or unnumbered
// line. A number on one side and not the other is a mismatch: the record is
// about something the picked address did not name.
export function sameStreetAddress(a: string, b: string): boolean {
  const aNum = houseNumberOf(a);
  const bNum = houseNumberOf(b);
  if (aNum !== bNum) return false;
  const aTokens = streetTokensOf(a);
  const bTokens = streetTokensOf(b);
  if (aTokens.length === 0 || bTokens.length === 0) return false;
  return (
    aTokens.length === bTokens.length &&
    aTokens.every((t, i) => t === bTokens[i])
  );
}

// The canonical street TYPES, as the values TOKEN_ALIASES normalizes to. Used
// only by the street-name comparison below, which drops a trailing one.
const STREET_TYPES: ReadonlySet<string> = new Set(Object.values(TOKEN_ALIASES));

// The identifying part of a street name: its tokens with the house number
// gone, the unit gone, and a TRAILING STREET TYPE gone too - so "Bolsa Chica
// St", "Bolsa Chica Road" and "Bolsa Chica" all reduce to ["bolsa", "chica"].
//
// Dropping the type is the difference between a usable check and an unusable
// one, and it was measured rather than guessed. Photon, asked about "16781
// Bolsa Chica St", answers with Bolsa Chica ROAD, Bolsa Chica Channel and
// Bolsa Chica State Beach: it plainly knows the place, and an exact-suffix
// comparison calls that a fabricated address. Directionals are NOT dropped -
// N Harbor and S Harbor are different streets and always have been.
export function streetNameCoreOf(line: string): string[] {
  const tokens = streetTokensOf(line);
  if (tokens.length > 1 && STREET_TYPES.has(tokens[tokens.length - 1])) {
    return tokens.slice(0, -1);
  }
  return tokens;
}

// Does any of `candidates` name the same street as `line`?
//
// This, not an exact address comparison, is what the geocoder check in
// src/lib/addressVerify.ts asks - and the reason is a measurement. Requiring
// Photon to return the exact house number refused four of ten real Orange
// County addresses in a live probe: OSM has good street coverage and patchy
// address-POINT coverage, so a real home routinely sits on a street the
// geocoder knows perfectly well while the number itself was never mapped.
// Refusing those would have swapped one vendor's data gap for another's, which
// is the entire mistake this check was introduced to undo.
//
// What it still catches is the thing worth catching: an invented street.
// Photon answers "123 Fake Street, California" with fifteen genuine addresses
// on North Sunkist, South Kingsley, South Kroeger and the rest - not one of
// them a Fake Street - so the core never matches and the address is refused.
// A made-up NUMBER on a real street gets through, and that is the deliberate
// trade: there is no way to tell 9065 Warner from 9067 Warner with data this
// incomplete, and guessing costs a real homeowner their signup.
export function matchesAnyStreetName(
  line: string,
  candidates: readonly string[]
): boolean {
  const core = streetNameCoreOf(line);
  if (core.length === 0) return false;
  return candidates.some((c) => {
    const cc = streetNameCoreOf(c);
    return cc.length === core.length && cc.every((t, i) => t === core[i]);
  });
}
