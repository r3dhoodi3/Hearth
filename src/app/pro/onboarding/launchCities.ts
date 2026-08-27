// The cities Hearth serves at launch, and the pure mapping from the
// checkboxes to what a contractors row actually stores.
//
// Neither pro signup nor the profile editor asks for a free-text service area
// any more. A pro checks "All of Orange County" or any of its cities, and that
// single answer feeds three columns:
//
//   service_area          the same comma-separated free text the rest of the
//                         app already renders (browse pros, applicant cards,
//                         the AI prompt builders): "Huntington Beach,
//                         Fountain Valley".
//   serves_orange_county  0074's launch attestation, which the job board
//                         (open_jobs_for_me) and apply_to_lead both gate on.
//                         EVERY launch city is in Orange County, so checking
//                         any one of them is a truthful yes.
//   launch_cities         0124's per-city pick (widened to nine cities in
//                         0126 and to all of Orange County in 0129), the
//                         narrower gate both of those functions ALSO apply: a
//                         job whose property ZIP maps to a city not in this
//                         array is hidden from the board and refused at apply
//                         time. This is why the answer can no longer be
//                         collapsed into the boolean.
//
// Both forms post the same field names (`service_cities` plus the hidden
// `service_cities_present` marker) to the same saveCompanyAction, so this is
// the single place the answer is interpreted. "All of Orange County" is not a
// value of its own: the checkbox component posts every city when it is
// checked, so nothing here has to know the shortcut exists.
//
// Order is canonical (the LAUNCH_CITIES order), never the order the pro
// happened to click, so the stored string is stable and comparable.
//
// The list itself is LAUNCH_CITY_NAMES from src/lib/serviceArea.ts, re-exported
// under the name the forms already use: the checkbox list and the ZIP map have
// to name exactly the same cities, so they read from one array rather than two
// that drift.
import { LAUNCH_CITY_NAMES, type LaunchCityName } from "@/lib/serviceArea";

export const LAUNCH_CITIES = LAUNCH_CITY_NAMES;

export type LaunchCity = LaunchCityName;

// How the checkbox component groups the 36 names on screen, so a pro scanning
// for their corner of the county reads a dozen names, not a wall. Rough
// geography, not an official split. Every launch city appears in exactly one
// group and nothing else does (launchCities.test.ts checks), so the grouping
// can never hide a city or offer one the ZIP map cannot match.
export const LAUNCH_CITY_GROUPS: readonly {
  label: string;
  cities: readonly LaunchCity[];
}[] = [
  {
    label: "North",
    cities: [
      "Anaheim",
      "Brea",
      "Buena Park",
      "Cypress",
      "Fullerton",
      "La Habra",
      "La Palma",
      "Los Alamitos",
      "Placentia",
      "Stanton",
      "Villa Park",
      "Yorba Linda",
    ],
  },
  {
    label: "Central",
    cities: [
      "Garden Grove",
      "Midway City",
      "Orange",
      "Santa Ana",
      "Tustin",
      "Westminster",
      "Irvine",
    ],
  },
  {
    label: "Coastal",
    cities: [
      "Seal Beach",
      "Huntington Beach",
      "Fountain Valley",
      "Costa Mesa",
      "Newport Beach",
      "Laguna Beach",
      "Dana Point",
      "San Clemente",
    ],
  },
  {
    label: "South",
    cities: [
      "Aliso Viejo",
      "Laguna Hills",
      "Laguna Niguel",
      "Laguna Woods",
      "Lake Forest",
      "Mission Viejo",
      "Rancho Santa Margarita",
      "San Juan Capistrano",
      "Ladera Ranch",
    ],
  },
];

export type LaunchCitySelection = {
  /** The checked cities, in canonical order. */
  cities: LaunchCity[];
  /** What to write to contractors.service_area, or null when nothing is checked. */
  serviceArea: string | null;
  /** What to write to contractors.serves_orange_county. */
  servesOrangeCounty: boolean;
};

// Maps raw posted checkbox values to the stored fields. Anything that isn't a
// launch city is dropped: the form only offers these names, so any other value
// is a crafted post rather than a pro's answer. Trimmed and case-insensitive
// because the values ride through a form post, and de-duplicated because the
// output is built from LAUNCH_CITIES rather than from the input.
export function selectLaunchCities(
  raw: readonly string[]
): LaunchCitySelection {
  const posted = new Set(raw.map((value) => String(value).trim().toLowerCase()));
  const cities = LAUNCH_CITIES.filter((city) =>
    posted.has(city.toLowerCase())
  );
  return {
    cities: [...cities],
    serviceArea: cities.length > 0 ? cities.join(", ") : null,
    servesOrangeCounty: cities.length > 0,
  };
}
