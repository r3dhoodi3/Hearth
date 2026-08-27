// Address autocomplete for the onboarding street box, backed by Photon
// (https://photon.komoot.io), the free OpenStreetMap-based geocoder Komoot
// runs. No key, no billing, no contract - which also means no uptime promise,
// so every caller here degrades to "no suggestions" rather than to an error.
// Typing the address by hand has to keep working exactly as it did before this
// file existed.
//
// This module is deliberately PURE: it builds the request URL and maps the
// response. The fetch, the cache, the timeout and the rate limit live in
// src/app/api/address-suggest/route.ts, which is where they can be reasoned
// about per-request. Keeping the mapping here is what makes the launch-city
// filter testable without a network.

import {
  LAUNCH_CITY_NAMES,
  launchCityForZip,
  type LaunchCityName,
} from "@/lib/serviceArea";

// The Orange County box, minLon,minLat,maxLon,maxLat - the order Photon's
// `bbox` parameter takes. Roughly the county's extent: Seal Beach in the
// northwest corner down to San Clemente in the southeast. A box, so it is
// wider than the county's real outline on purpose - the bbox is a cheap
// server-side prefilter that keeps Photon from ranking a Bolivian village
// above a Bolsa Avenue address, and the exact launch-area gate is applied
// below on the way out.
export const OC_BBOX = {
  minLon: -118.13,
  minLat: 33.38,
  maxLon: -117.41,
  maxLat: 33.95,
} as const;

// What the client actually renders and fills the form with. Deliberately the
// four fields the onboarding form has boxes for, and nothing else: this is a
// typing aid, not a second source of property facts. The real record still
// comes from the parcel lookup that Continue runs.
export interface AddressSuggestion {
  line1: string;
  city: LaunchCityName;
  // Every launch city is in California; there is no second state to carry.
  state: "CA";
  zip: string;
}

// Below three characters a query is not a search, it is a keystroke - Photon
// would return the whole county and the list would flicker through noise on
// the way to something useful.
export const MIN_SUGGEST_QUERY = 3;
// Matches MAX_ADDRESS_LENGTH on the street box in OnboardingForm.tsx. This
// value reaches an outbound request URL, so it is capped here too rather than
// trusted from the client.
export const MAX_SUGGEST_QUERY = 200;

// How many suggestions the client is ever shown. Small on purpose: this list
// sits under an input on a phone, and a fifth option is already below the
// fold on the smallest screens.
export const SUGGEST_LIMIT = 5;

// How many raw features to ask Photon for. Much larger than SUGGEST_LIMIT
// because most of what comes back is thrown away here: streets with no house
// number, bus stops, and anything outside the launch area. Asking for five
// raw results routinely left one usable suggestion, or none.
export const PHOTON_RAW_LIMIT = 15;

const LAUNCH_CITY_SET: ReadonlySet<string> = new Set(
  LAUNCH_CITY_NAMES.map((c) => c.toLowerCase())
);

// Collapses whitespace and caps length. Returns "" for anything too short to
// search, which is the signal every caller uses to skip the request entirely.
export function normalizeSuggestQuery(raw: string | null | undefined): string {
  const q = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_SUGGEST_QUERY);
  return q.length < MIN_SUGGEST_QUERY ? "" : q;
}

// Builds the Photon request URL for a partly typed street line.
//
// The typed text is not sent alone. Photon ranks a bare "9832 Bol" against the
// whole planet and answers with a peak in Zacatecas; worse, it returns NOTHING
// at all for a house number followed by a partial street name unless the query
// carries enough context to read as an address. Appending the city (when the
// ZIP box already names one) and "California" is what turns that same query
// into "9842 Bolsa Avenue, Westminster". The bbox narrows it further.
//
// `zip` is the value in the form's ZIP box, which is often typed before the
// street is finished. Only a launch ZIP contributes a city - anything else is
// ignored rather than sent, since a wrong city hurts the ranking.
export function photonSuggestUrl(query: string, zip?: string | null): string {
  const city = zip ? launchCityForZip(zip) : null;
  const q = [query, city, "California"].filter(Boolean).join(", ");
  const params = new URLSearchParams({
    q,
    bbox: `${OC_BBOX.minLon},${OC_BBOX.minLat},${OC_BBOX.maxLon},${OC_BBOX.maxLat}`,
    limit: String(PHOTON_RAW_LIMIT),
    lang: "en",
  });
  return `https://photon.komoot.io/api/?${params.toString()}`;
}

// The handful of GeoJSON properties this reads. Everything is optional:
// Photon returns streets, cities, mountains and bus stops through the same
// shape, and a missing field must drop the result rather than become a guess.
interface PhotonProperties {
  housenumber?: unknown;
  street?: unknown;
  city?: unknown;
  postcode?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Maps a Photon FeatureCollection to the suggestions the form can use.
//
// Three filters, in order of how much they throw away:
//   1. No house number or no street name - a street centerline, a city, a bus
//      stop. None of those is a home, and filling the box with one would send
//      an unclaimable line into the parcel lookup.
//   2. No ZIP, or a ZIP outside the launch area. The ZIP is what every
//      downstream gate keys on (isLaunchZip in onboarding, the pro-side alert
//      filter, the DB's launch_city_for_zip), so a suggestion whose ZIP would
//      be rejected on the very next screen has no business being offered, no
//      matter what city name OSM attached to it.
//   3. Duplicates - OSM routinely holds several nodes for one address (the
//      building, the entrance, a shop inside it).
//
// Takes `unknown` rather than a typed body because this is a third-party
// response: it is parsed defensively and a shape surprise yields an empty
// list, never a throw.
export function mapPhotonResults(
  body: unknown,
  limit: number = SUGGEST_LIMIT
): AddressSuggestion[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];

  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();

  for (const feature of features) {
    if (out.length >= limit) break;
    const props = (feature as { properties?: PhotonProperties } | null)
      ?.properties;
    if (!props || typeof props !== "object") continue;

    const housenumber = str(props.housenumber);
    const street = str(props.street);
    if (!housenumber || !street) continue;

    // First five digits only, same normalization launchCityForZip and
    // isOrangeCountyZip use, so a ZIP+4 resolves the way it does everywhere
    // else in the app.
    const zip = str(props.postcode).slice(0, 5);
    const zipCity = launchCityForZip(zip);
    if (!zipCity) continue;

    // The ZIP is the gate (above); the city shown is a display choice. Prefer
    // the place name OSM has for the address when it is itself a launch city:
    // along the Westminster/Garden Grove line the two disagree, and the name
    // on the mailbox is the one the resident recognizes. Otherwise the ZIP's
    // city is shown: OSM files plenty of Orange County addresses under the
    // neighborhood or the annexed community (Corona del Mar, Sunset Beach,
    // Capistrano Beach, Trabuco Canyon), and none of those is a name the
    // checkboxes or the DB gate know, so the ZIP map is what turns each into
    // the city that serves it.
    const osmCity = str(props.city);
    const city: LaunchCityName = LAUNCH_CITY_SET.has(osmCity.toLowerCase())
      ? (osmCity as LaunchCityName)
      : zipCity;

    const line1 = `${housenumber} ${street}`;
    const key = `${line1.toLowerCase()}|${zip}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ line1, city, state: "CA", zip });
  }

  return out;
}
