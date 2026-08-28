// Fuzzy match between the account holder's name and the county assessor's
// owner-of-record (RentCast's owner.names, via src/lib/parcel.ts), used to
// derive properties.ownership_status (migration 0093). Pure and I/O-free on
// purpose: the caller does all the fetching, this module just decides.
//
// This is a SOFT trust signal, not identity verification: assessor records
// lag sales by months, and miss living trusts, recent marriages, and
// spouses who were never added to title. A non-match must stay "quietly
// unverified", never an accusation.
//
// Worked examples:
//   matchOwnerName("John A Smith", ["SMITH JOHN A"], "individual")        -> true
//     (surname "smith" shared, first name "john" shared as a full token)
//   matchOwnerName("J Smith", ["Smith, John"], "individual")              -> true
//     (surname "smith" shared; the user's remaining token "j" is nothing
//     but an initial, so it may stand in for "john")
//   matchOwnerName("John Smith", ["Smith Jane"], "individual")            -> false
//     (surname shared, but no first-name/initial match - different person)
//   matchOwnerName("Adam Smith", ["SMITH JAMES A"], "individual")         -> false
//     (surname shared, but "a" is JAMES's own middle initial, not evidence
//     for "Adam" - the owner side still has a full token, "james", that
//     never matched, so the stray initial is not trusted as a fallback)
//   matchOwnerName("Maria Lopez", ["Lopez Family Trust"], "organization") -> true
//     (the user's surname, "lopez", appears in the org name, and it's a trust)
//   matchOwnerName("Maria Lopez", ["Lopez Plumbing LLC"], "organization") -> false
//     (surname matches, but plain LLCs/corps never match - too likely a
//     coincidence, e.g. the owner sold to an unrelated LLC with a common name)
//   matchOwnerName("John Doe", ["JOHN AND MARY SMITH TRUST"], "organization") -> false
//     (Doe's surname, "doe", never appears in the org name - sharing an
//     unrelated given name, "john", with one of the trust's namesakes is
//     not surname evidence)

const SUFFIX_TOKENS = new Set(["jr", "sr", "ii", "iii", "iv"]);

// Family-entity keywords: an organization owner only counts as a match when
// the name both contains the user's own surname AND reads like a family
// holding vehicle, not a plain business. Deliberately narrow - a false
// match here would tell a stranger's LLC purchase "you own this home".
const FAMILY_ENTITY_WORDS = ["trust", "family", "living", "revocable"];

// Lowercase, strip punctuation and diacritics, collapse whitespace, drop
// suffix tokens (jr/sr/ii/iii/iv), and split into tokens. Token ORDER is
// discarded on purpose: assessor records mix "LAST FIRST MIDDLE" and
// "First Last" freely, so every comparison below works on token sets.
function tokenize(name: string): string[] {
  const normalized = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (combining marks left by NFD)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];
  return normalized.split(" ").filter((t) => t && !SUFFIX_TOKENS.has(t));
}

// The user's surname candidate(s), for the organization match only: drop
// the first whitespace-separated word (the given name) and keep up to the
// LAST TWO of what remains, each further split on any hyphen it contains
// ("Smith-Jones" -> ["smith", "jones"]). Two, not one, so a space-separated
// compound surname ("Maria Garcia Lopez") keeps both halves instead of only
// "lopez" - matching only the literal last word silently failed to match
// "GARCIA FAMILY TRUST" for its own owner. Single-letter tokens are dropped
// so a middle initial ("John A Smith" -> "a") never becomes a candidate.
//
// Deliberately narrower than tokenize()'s full token set - matching an
// organization name against ANY token in the user's name (their given name
// itself) is what let "John Doe" match "JOHN AND MARY SMITH TRUST" on the
// shared given name "john"; dropping the first word keeps that fixed even
// for a plain two-word name ("John Doe" -> just "doe").
//
// TRADEOFF: for a three-or-more-word name, the second-to-last word is
// sometimes a middle name, not part of the surname ("John Michael Smith"
// -> "michael" and "smith" both become candidates). That slightly widens
// what an organization can match on. Acceptable for a soft trust signal -
// better to occasionally over-match a middle name than to silently drop
// half of a real compound surname.
function surnameCandidates(fullName: string): string[] {
  const normalized = fullName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ") // strip punctuation but keep hyphens for now
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];
  const words = normalized.split(" ").filter((w) => w && !SUFFIX_TOKENS.has(w));
  if (words.length === 0) return [];
  const withoutGivenName = words.length > 1 ? words.slice(1) : words;
  const tail = withoutGivenName.slice(-2);
  return tail
    .flatMap((w) => w.split("-").filter(Boolean))
    .filter((t) => t.length > 1); // a bare initial is never surname evidence
}

// True when `a` is a single-letter initial of `b` (or vice versa): "j"
// against "john". Equal-length tokens never count as an initial match -
// that's the exact-token check below, not this one.
function isInitialOf(a: string, b: string): boolean {
  if (a.length === 1 && b.length > 1) return b[0] === a;
  if (b.length === 1 && a.length > 1) return a[0] === b;
  return false;
}

function matchIndividual(userTokens: string[], ownerTokens: string[]): boolean {
  // Surname candidates: any token of real length (>= 3 chars) shared by
  // both sides, verbatim. A single shared token that short (or a bare
  // initial) is never enough on its own - too likely to be a coincidence.
  const ownerSet = new Set(ownerTokens);
  const sharedLong = userTokens.filter((t) => t.length >= 3 && ownerSet.has(t));
  if (sharedLong.length === 0) return false;

  for (const surname of sharedLong) {
    // Need one MORE shared token beyond the surname itself: either another
    // exact shared token, or (only as a fallback - see below) an initial
    // match between the remaining tokens on each side.
    const userRest = userTokens.filter((t) => t !== surname);
    const ownerRest = ownerTokens.filter((t) => t !== surname);
    if (userRest.length === 0 || ownerRest.length === 0) continue;

    const ownerRestSet = new Set(ownerRest);
    const hasExtraExact = userRest.some((t) => ownerRestSet.has(t));
    if (hasExtraExact) return true;

    // Full-token evidence beats initials: if a side still has a real (>= 2
    // char) given name left over, a stray initial elsewhere is not allowed
    // to paper over that name failing to match. "SMITH JAMES A" vs "Adam
    // Smith" is exactly this - "a" is JAMES's own middle initial, not
    // evidence for a different person named Adam. Initials are trusted only
    // when a side has NOTHING BUT initials left, i.e. it never carried a
    // full given name to compare in the first place (an abbreviated
    // assessor record like "LEE J" against "Jennifer Lee" must still match).
    const userAllInitials = userRest.every((t) => t.length === 1);
    const ownerAllInitials = ownerRest.every((t) => t.length === 1);
    if (!userAllInitials && !ownerAllInitials) continue;

    const hasInitialMatch = userRest.some((u) =>
      ownerRest.some((o) => isInitialOf(u, o))
    );
    if (hasInitialMatch) return true;
  }
  return false;
}

function matchOrganization(surnameTokens: string[], ownerName: string): boolean {
  const lower = ownerName.toLowerCase();
  const isFamilyEntity = FAMILY_ENTITY_WORDS.some((w) => lower.includes(w));
  if (!isFamilyEntity) return false;

  // Exclude the family/trust keywords themselves from both token sets: a
  // keyword only signals "this reads like a family entity", it must never
  // double as the surname evidence that ties the entity to this user (e.g.
  // a user whose own surname happens to be "Family").
  const orgTokens = new Set(
    tokenize(ownerName).filter((t) => !FAMILY_ENTITY_WORDS.includes(t))
  );
  const candidates = surnameTokens.filter((t) => !FAMILY_ENTITY_WORDS.includes(t));
  return candidates.some((t) => t.length >= 3 && orgTokens.has(t));
}

// Matches the account holder's full name against every name on the
// assessor record; any single match wins (co-owners, either spouse listed).
export function matchOwnerName(
  fullName: string,
  ownerNames: string[],
  ownerType: string | null
): boolean {
  if (ownerNames.length === 0) return false;

  const type = (ownerType ?? "").toLowerCase();
  if (type === "organization") {
    // Organization match uses the user's surname only (see
    // surnameCandidates), never their full token set - matching on any
    // shared token (a given name, say) is what let an unrelated "John Doe"
    // match "JOHN AND MARY SMITH TRUST" on the shared first name "john".
    const surnames = surnameCandidates(fullName);
    if (surnames.length === 0) return false;
    return ownerNames.some((name) => matchOrganization(surnames, name));
  }
  // Individual, or an unrecognized/missing type: try the individual match.
  // Assessor records occasionally omit owner.type even for a person, so
  // this stays permissive rather than refusing to check at all.
  const userTokens = tokenize(fullName);
  if (userTokens.length === 0) return false;
  return ownerNames.some((name) => matchIndividual(userTokens, tokenize(name)));
}

// Rolls the "do we even have enough to check" logic together with the match
// itself, so callers (onboarding, job posting) don't duplicate the
// missing-data guard. Anything missing - no name on file, no assessor
// owner data - resolves to 'unverified', never a guess.
export function deriveOwnershipStatus(
  fullName: string | null,
  facts: { owner_names: string[] | null; owner_type: string | null }
): "verified" | "unverified" {
  if (!fullName || !fullName.trim()) return "unverified";
  if (!facts.owner_names || facts.owner_names.length === 0) return "unverified";
  return matchOwnerName(fullName, facts.owner_names, facts.owner_type)
    ? "verified"
    : "unverified";
}

// Whether an ownership check should be RECORDED at all for these facts.
//
// record_ownership_check (migration 0095) stamps ownership_checked_at = now()
// on every call, and a null ownership_checked_at is the ONLY thing that makes
// a property eligible for the lazy re-check on its first job post
// (src/app/(app)/contractors/actions.ts). So recording anything is a one-way
// door: it spends the retry.
//
// That is exactly the wrong thing to spend on a records source we could not
// reach (source "unavailable" - a 401 from a bad key, a 429, a 5xx, a
// timeout). Writing "unverified" there would freeze an outage into a
// permanent verdict: the home stays unverified forever, and its job posts
// never get the fan-out that verified homes get. A real record is a verdict
// worth keeping; an outage is a "come back later".
//
// Null facts (a lookup that was rate-limited or threw) are the same "come back
// later", and are already handled the same way.
//
// SO IS A MISS (source "none"), as of 2026-08-28, and that one is a change.
// A miss carries no owner of record at all, so there is nothing to match a
// name against and no verdict to keep - recording it writes "unverified" on
// the strength of having asked a source that had never heard of the address.
// That was harmless while a miss refused the claim outright and could never
// reach this code; now that a miss walks on to manual entry (see
// src/lib/parcelGate.ts) it is the common case, and RentCast's coverage of the
// launch metro is patchy enough that the same address may well be in the data
// next month. Leaving ownership_checked_at null is what keeps the lazy
// re-check on first job post eligible to find out.
export function shouldRecordOwnershipCheck(
  facts: { source: string } | null | undefined
): boolean {
  return facts != null && facts.source === "rentcast";
}
