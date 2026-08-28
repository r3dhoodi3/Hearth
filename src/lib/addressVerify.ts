// Does this street address exist at all?
//
// WHY THIS EXISTS. Until 2026-08-28 the answer came from RentCast: onboarding
// refused any address the property-records lookup had no record for, and that
// refusal was the only thing standing between "123 Fake St" and a real home
// row. Then a persona run measured RentCast's actual coverage of the launch
// metro, and it is patchy - four plausible Orange County addresses (1920 Main
// St Irvine, 800 Baker St Costa Mesa, 1201 Magnolia Ave Anaheim, 1620 E 1st St
// Santa Ana) each came back a hard 404, in every address format tried. Keeping
// the records source as the gate would have turned a gap in one vendor's data
// into a locked door for real homeowners, so a records miss now walks on to
// manual entry instead.
//
// That moves the fake-address job here, to Photon - the OpenStreetMap
// geocoder already behind the autocomplete. It is the right division of labour
// anyway: OSM answers "is there a street here", RentCast answers "what does
// the assessor know about the building", and only the first is a question
// about whether the address is real.
//
// THE BAR IS THE STREET, NOT THE HOUSE NUMBER, and that was measured rather
// than assumed. A first cut required Photon to return the exact numbered
// address; a live probe of ten real Orange County addresses refused four of
// them, because OSM's street coverage is good while its address-POINT coverage
// is patchy - "16781 Bolsa Chica St" comes back as Bolsa Chica Road, Bolsa
// Chica Channel and Bolsa Chica State Beach, all of which plainly know the
// place, and none of which is that house. Shipping that would have swapped
// RentCast's data gap for OSM's and left the same locked door.
//
// So the refusal is narrow on purpose: Photon named some streets, and not one
// of them is the street typed. That still catches the thing worth catching -
// "123 Fake Street" returns fifteen real addresses on North Sunkist, South
// Kingsley and the rest, no Fake Street among them. It lets a made-up NUMBER
// on a real street through, which is the deliberate trade: nothing available
// here can separate 9065 Warner from 9067 Warner, and guessing costs a real
// homeowner their signup. See matchesAnyStreetName in src/lib/addressMatch.ts.
//
// FAILS OPEN, always. Photon is a free community service with no uptime
// promise (see src/lib/addressSuggest.ts). A timeout, a 500 or a body we
// cannot parse yields "unavailable", and every caller treats that as "let them
// through": a geocoder outage must never become a day of real homeowners being
// told their house does not exist. That is precisely the mistake this codebase
// already made once with RentCast on 2026-08-24.

import {
  normalizeSuggestQuery,
  photonStreetNames,
  photonSuggestUrl,
} from "@/lib/addressSuggest";
import { matchesAnyStreetName } from "@/lib/addressMatch";

//   "match"       - Photon returned an address line that IS this one.
//   "no_match"    - Photon answered, and nothing it returned is this address.
//                   The only verdict that refuses a claim.
//   "unavailable" - we could not ask, or could not ask meaningfully. Never a
//                   refusal.
export type AddressVerdict = "match" | "no_match" | "unavailable";

// Longer than the autocomplete's 3s (src/app/api/address-suggest/route.ts)
// because this is a different kind of request: it runs once, on a button the
// homeowner already expects to take a moment, and there is no next keystroke
// coming to make the answer stale. Short enough that a hung geocoder still
// falls open quickly rather than sitting on the Continue button.
const VERIFY_TIMEOUT_MS = 5_000;

// The same address gets checked twice on a normal signup - once on Continue,
// once on Claim - and a household re-typing after a correction makes it more.
// Ten minutes matches the autocomplete cache next door, for the same reason:
// OSM does not move on a shorter horizon.
const VERIFY_CACHE_TTL_MS = 10 * 60 * 1000;
// Bounded, because this is a module-level Map in a long-lived server process.
// Oldest-inserted evicted first, same approximation the suggest cache uses.
const VERIFY_CACHE_MAX_ENTRIES = 200;

type CacheEntry = { at: number; verdict: "match" | "no_match" };
const cache = new Map<string, CacheEntry>();

function cacheKey(street: string, zip: string): string {
  return (
    street.trim().replace(/\s+/g, " ").toLowerCase() +
    "|" +
    zip.trim().slice(0, 5)
  );
}

// Exported for the tests, which would otherwise leak one case's verdict into
// the next. Nothing in the app calls it.
export function resetAddressVerifyCache(): void {
  cache.clear();
}

export async function verifyAddressExists(
  street: string,
  zip: string
): Promise<AddressVerdict> {
  const q = normalizeSuggestQuery(street);
  // Too short to be a search. Nothing to check, so nothing to refuse on -
  // the length rules in onboarding/actions.ts already have this covered.
  if (!q) return "unavailable";

  const key = cacheKey(street, zip);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= VERIFY_CACHE_TTL_MS) return hit.verdict;
  if (hit) cache.delete(key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    // The same URL builder the autocomplete uses, so the query carries the
    // launch city for the ZIP and "California" and is boxed to Orange County.
    // A bare street line ranks against the whole planet; the context is what
    // makes Photon read it as an address at all.
    const res = await fetch(photonSuggestUrl(q, zip || null), {
      signal: controller.signal,
      headers: {
        "User-Agent": "Hearth/1.0 (+https://hearth.build)",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(
        `Photon address verification returned HTTP ${res.status} - allowing`
      );
      return "unavailable";
    }
    const names = photonStreetNames(await res.json());
    // NO RESULTS AT ALL IS NOT A "NO".
    //
    // Photon answers a real query with a page of candidates and a broken one
    // with nothing, and the two are hard to tell apart from here - an empty
    // body is as consistent with a bad bbox, a service degradation, or an
    // indexing gap as it is with "this address is invented". A refusal has to
    // rest on Photon having actually named streets, none of which is this
    // one. That is the shape a made-up address really has: "123 Fake Street"
    // comes back with fifteen genuine addresses on other streets.
    if (names.length === 0) {
      console.error(
        "Photon address verification returned no street names - allowing"
      );
      return "unavailable";
    }
    const verdict = matchesAnyStreetName(street, names) ? "match" : "no_match";
    cache.set(key, { at: Date.now(), verdict });
    while (cache.size > VERIFY_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return verdict;
  } catch (err) {
    // AbortError (the timeout), a DNS/network failure, a body that is not
    // JSON. Fail open, loudly enough to notice in the logs if it becomes the
    // normal case.
    console.error("Photon address verification could not complete:", err);
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}
