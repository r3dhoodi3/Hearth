// Does the name CSLB has on file for a license actually belong to the pro
// claiming it on Hearth?
//
// WHY THIS EXISTS: src/lib/cslb.ts only answers "is this license number
// current and active". Until this file shipped, that was the whole check, so
// anyone could paste a stranger's valid CSLB number into their profile and
// collect a real "License verified" badge on someone else's credential. This
// module is the identity half: compare the business name CSLB registered
// against the names Hearth knows for the account.
//
// DELIBERATELY LENIENT. A false rejection locks a legitimate pro out of the
// badge they earned, and real-world names disagree constantly:
//   - CSLB stores sole proprietors surname-first ("DOE JOHN"), Hearth stores
//     "John Doe";
//   - one side carries INC / LLC / CORP and the other doesn't;
//   - CSLB packs a "dba" trade name into the same line;
//   - a pro trades as "Doe Plumbing" under a license held by "JOHN DOE".
// So the bar is one shared significant word, in any order. The strong
// guarantee against license theft is NOT this comparison - it is the
// one-license-one-account lock (migration 0125 plus the app-side pre-check in
// src/app/pro/actions.ts): a license number can be verified on exactly one
// Hearth account, so a thief cannot silently ride along on a real pro's
// credential, and the loser of that race has a dispute path.

// Words that carry no identity. Stripped from both sides before comparing so
// "ACME PLUMBING INC" and "Acme Plumbing LLC" are the same company. Note
// punctuation is removed first, so "L.L.C." arrives here as "LLC".
const CORPORATE_STOPWORDS = new Set([
  "INC",
  "INCORPORATED",
  "LLC",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "LTD",
  "DBA",
  "THE",
  "AND",
  "OF",
]);

// A token has to be at least this long to prove anything on its own. Initials
// and two-letter fragments ("JR", "SO") match far too easily across unrelated
// businesses to count as evidence by themselves.
const SIGNIFICANT_TOKEN_LENGTH = 3;

// Trade and filler words that describe what a contractor does, not who they
// are. "Acme Plumbing" and "Smith Plumbing" share PLUMBING and are different
// companies, so a shared word from this list is never evidence by itself.
// Unlike CORPORATE_STOPWORDS these are NOT stripped during normalization:
// they still count toward the whole-string containment test, which is how a
// business legitimately named ONLY generic words ("Home Repair Services")
// keeps matching its own CSLB record.
const GENERIC_TRADE_WORDS = new Set([
  "PLUMBING", "PLUMBER", "PLUMBERS",
  "ELECTRIC", "ELECTRICAL", "ELECTRICIAN", "ELECTRICIANS",
  "CONSTRUCTION", "CONTRACTING", "CONTRACTOR", "CONTRACTORS",
  "BUILDER", "BUILDERS", "BUILDING",
  "ROOFING", "PAINTING", "FLOORING", "PAVING", "CONCRETE", "MASONRY",
  "LANDSCAPE", "LANDSCAPING",
  "HVAC", "HEATING", "COOLING", "AIR", "CONDITIONING",
  "HANDYMAN", "MAINTENANCE", "REPAIR", "REPAIRS",
  "REMODEL", "REMODELING", "RENOVATION", "RENOVATIONS",
  "IMPROVEMENT", "IMPROVEMENTS",
  "HOME", "HOMES", "HOUSE",
  "GENERAL", "SERVICE", "SERVICES", "INSTALLATION",
  "DESIGN", "GROUP", "ENTERPRISES", "SOLUTIONS",
]);

// Uppercase, decode HTML entities, drop punctuation, drop corporate
// stopwords and standalone single letters (middle initials, "A" in "A & B
// Plumbing"). Returns the surviving words in source order; callers treat them
// as an unordered set, since CSLB's surname-first sole-proprietor records
// never line up positionally with a Hearth business name.
export function normalizeBusinessName(raw: string): string[] {
  if (!raw || typeof raw !== "string") return [];

  // Entities first: the CSLB page is scraped HTML, so "&amp;" / "&#39;" can
  // survive into the stored business name. They are separators or noise, never
  // identity, so they become spaces rather than letters.
  const decoded = raw
    .replace(/&#\d+;/g, " ")
    .replace(/&#x[0-9a-f]+;/gi, " ")
    .replace(/&[a-z]+;/gi, " ");

  return decoded
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(
      (token) =>
        token.length > 1 && !CORPORATE_STOPWORDS.has(token)
    );
}

// True when the CSLB-registered name plausibly belongs to this account.
//
// Passes when ANY candidate (the Hearth business name, the account holder's
// full name, ...) either:
//   a. shares at least one significant word with the CSLB name, in any order -
//      the core test, because CSLB sole-proprietor records are surname-first.
//      Generic trade words (PLUMBING, CONSTRUCTION, ...) don't count here:
//      "Acme Plumbing" and "Smith Plumbing" are different companies; or
//   b. normalizes to a string that contains, or is contained by, the CSLB
//      name's - which catches a trade name that simply extends the registered
//      one.
// A CSLB name with nothing left after normalization ("INC", punctuation, an
// empty string) can never match: there is nothing to compare, and callers must
// treat that as unknown rather than confirmed.
export function licenseNameMatches(
  cslbName: string,
  candidates: Array<string | null | undefined>
): boolean {
  const cslbTokens = normalizeBusinessName(cslbName ?? "");
  if (cslbTokens.length === 0) return false;

  const cslbNormalized = cslbTokens.join(" ");
  // Only identity-bearing words count as single-word evidence: long enough to
  // mean something, and not a generic trade word every second contractor has
  // in their name.
  const cslbSignificant = new Set(
    cslbTokens.filter(
      (t) => t.length >= SIGNIFICANT_TOKEN_LENGTH && !GENERIC_TRADE_WORDS.has(t)
    )
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    const tokens = normalizeBusinessName(candidate);
    if (tokens.length === 0) continue;

    const normalized = tokens.join(" ");
    if (normalized === cslbNormalized) return true;

    // Containment, anchored to TOKEN BOUNDARIES, and only for a multi-word
    // shorter side. A raw substring test let a two-character company name
    // ("Ndo") match "MENDOZA CONSTRUCTION" and forge the badge; padding with
    // spaces means only whole-word runs count, and the two-token floor stops a
    // lone word from matching by containment (a lone word must instead pass
    // the significant-token test below, which excludes generic trade words).
    const [shortTokens, longStr, shortStr] =
      tokens.length <= cslbTokens.length
        ? [tokens, cslbNormalized, normalized]
        : [cslbTokens, normalized, cslbNormalized];
    if (
      shortTokens.length >= 2 &&
      ` ${longStr} `.includes(` ${shortStr} `)
    ) {
      return true;
    }

    for (const token of tokens) {
      if (cslbSignificant.has(token)) {
        return true;
      }
    }
  }

  return false;
}

// CSLB license numbers are numeric; a pro may have typed "LIC# 270663" or
// "270-663". This is the app-side twin of the migration 0125 index expression
// regexp_replace(license_number, '\D', '', 'g') - two spellings of a license
// number must collapse to the same identity on BOTH sides, or the app-side
// duplicate pre-check and the database's unique index would disagree about
// what "the same license" means.
export function licenseDigits(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).replace(/\D/g, "");
}

// A real CSLB license number is 5 to 8 plain digits (most active ones are 6
// or 7, e.g. 1029384); nothing else belongs in the field. Spaces are ignored
// entirely rather than treated as invalid, since a pro copy-pasting "1029 384"
// is not making a mistake. Blank is not validated here - the field is
// optional, so an empty value is a caller's decision, not this function's.
export function isValidLicenseNumber(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const digits = licenseDigits(String(raw).replace(/\s/g, ""));
  if (digits !== String(raw).replace(/\s/g, "")) return false;
  return digits.length >= 5 && digits.length <= 8;
}
