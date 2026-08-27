import { OC_INCORPORATED_CITIES } from "./ocCities";

// TODO(verify): generated from general OC ZIP knowledge; verify against the
// HUD-USPS ZIP crosswalk (huduser.gov) before launch. Border ZIPs shared with
// LA County are a known imperfect edge. Since the launch area became all of
// Orange County (migration 0129) this set is ALSO the homeowner gate, so a
// residential ZIP missing from it turns a real Orange County home away: two
// such omissions (92694 Ladera Ranch, 92832 downtown Fullerton) were found and
// added in 0129, and the crosswalk pass should look for any others.
//
// Standard (residential-delivery) 5-digit ZIP codes for Orange County,
// California, across its cities: Aliso Viejo, Anaheim, Brea, Buena Park,
// Costa Mesa, Cypress, Dana Point, Fountain Valley, Fullerton, Garden Grove,
// Huntington Beach, Irvine, La Habra, La Palma, Laguna Beach, Laguna Hills,
// Laguna Niguel, Laguna Woods, Lake Forest, Los Alamitos, Midway City,
// Mission Viejo,
// Newport Beach, Orange, Placentia, Rancho Santa Margarita, San Clemente,
// San Juan Capistrano, Santa Ana, Seal Beach, Stanton, Trabuco Canyon,
// Tustin, Villa Park, Westminster, Yorba Linda, and unincorporated areas
// (Silverado/Modjeska, Sunset Beach, Surfside, Ladera Ranch). Excludes
// unique/PO-box-only ZIPs that have no residential delivery.
export const ORANGE_COUNTY_ZIPS: Set<string> = new Set([
  // Buena Park, Cypress, La Habra, Stanton, Los Alamitos, Seal Beach,
  // Sunset Beach, Surfside, La Palma - OC cities routed through 90xxx ZIPs,
  // the classic OC/LA County border overlap.
  "90620", "90621", "90623", "90630", "90631", "90680", "90720", "90740",
  "90742", "90743",
  // Irvine
  "92602", "92603", "92604", "92606", "92610", "92612", "92614", "92617",
  "92618", "92620",
  // Dana Point, Costa Mesa, San Juan Capistrano, Lake Forest, Laguna Woods,
  // Huntington Beach
  "92624", "92625", "92626", "92627", "92629", "92630", "92637", "92646",
  "92647", "92648", "92649",
  // Laguna Beach, Laguna Hills, Midway City, Aliso Viejo, Newport Beach,
  // San Clemente, San Juan Capistrano
  "92651", "92653", "92655", "92656", "92657", "92660", "92661", "92662",
  "92663", "92672", "92673", "92675",
  // Silverado/Modjeska, Laguna Niguel, Trabuco Canyon, Westminster, Rancho
  // Santa Margarita, Mission Viejo, Ladera Ranch, Santa Ana
  "92676", "92677", "92678", "92679", "92683", "92688", "92691", "92692",
  "92694", "92701", "92703", "92704",
  // Santa Ana, Fountain Valley, Tustin, Anaheim
  "92705", "92706", "92707", "92708", "92780", "92782", "92801", "92802",
  "92804", "92805", "92806",
  // Anaheim, Brea, Fullerton
  "92807", "92808", "92821", "92823", "92831", "92832", "92833", "92835",
  // Garden Grove
  "92840", "92841", "92843", "92844", "92845",
  // Orange, Villa Park
  "92856", "92861", "92864", "92865", "92866", "92867", "92868", "92869",
  // Placentia, Yorba Linda
  "92870", "92885", "92886", "92887",
]);

// Normalizes to the first 5 digits (handles ZIP+4 and stray whitespace) and
// checks membership in ORANGE_COUNTY_ZIPS.
export function isOrangeCountyZip(zip: string): boolean {
  const normalized = (zip ?? "").trim().slice(0, 5);
  return ORANGE_COUNTY_ZIPS.has(normalized);
}

// The unincorporated communities that are launch cities in their own right:
// each has a ZIP of its own that LAUNCH_CITY_BY_ZIP resolves to it. The other
// communities in OC_COMMUNITIES (./ocCities.ts) are deliberately NOT here:
// North Tustin shares 92705 with Santa Ana, Rossmoor shares 90720 with Los
// Alamitos, and Coto de Caza shares 92679 with the Rancho Santa Margarita
// tracts, and a ZIP maps to one city (the incorporated one). A pro who could
// check a name no ZIP ever resolves to would get a silently empty job board,
// so the rule is: LAUNCH_CITY_NAMES only holds names at least one ZIP maps to
// (src/lib/serviceArea.test.ts asserts it). The free-text matcher in
// ./ocCities.ts still knows all five, which is fine: it suggests words, it
// does not gate anything.
export const LAUNCH_COMMUNITIES = ["Ladera Ranch", "Midway City"] as const;

// The cities Hearth launches in, in canonical order: since migration 0129 that
// is all of Orange County, the 34 incorporated cities (OC_INCORPORATED_CITIES
// in ./ocCities.ts, one list, not two that drift) plus the two communities
// above, 36 names. Everything city-shaped reads this: the signup/profile
// checkboxes (src/app/pro/onboarding/launchCities.ts re-exports it as
// LAUNCH_CITIES), the LaunchCityName type below, the Organization JSON-LD in
// src/app/layout.tsx, and the CHECK constraint on contractors.launch_cities in
// migration 0129, which must list the same 36 names
// (src/lib/serviceArea.test.ts reads the .sql file and checks that it does).
//
// Order is incorporated cities alphabetically, then the communities, which is
// also the order a pro's service_area string is written in, so the stored
// string is stable no matter how boxes were clicked.
export const LAUNCH_CITY_NAMES = [
  ...OC_INCORPORATED_CITIES,
  ...LAUNCH_COMMUNITIES,
] as const;

export type LaunchCityName = (typeof LAUNCH_CITY_NAMES)[number];

// How the launch area is described to a person. One string, because the same
// claim appears on the landing page, /pros, both onboarding flows, the profile
// editor, and the pro AI prompt. Written to read after "Serving" and after
// "covers": "Serving all of Orange County".
export const LAUNCH_AREA_LABEL = "all of Orange County";

// The one message every homeowner-side onboarding gate shows: the two ZIP
// checks in src/app/onboarding/actions.ts and the fast client-side copy in
// OnboardingForm.tsx. Lives here rather than in a "use server" file because
// such a file can only export async functions, which is why the client copy
// used to be duplicated by hand.
export const LAUNCH_ONLY_MESSAGE =
  `Hearth serves ${LAUNCH_AREA_LABEL} right now. We added you to the ` +
  "waitlist and will email you the moment we expand to your area.";

// The post-time twin of the message above, for a home that was claimed before
// the launch gate existed and sits outside the launch area. Read by all three
// gates in src/app/(app)/contractors/actions.ts (postJobAction,
// requestProAction, postDirectPubliclyAction). Different wording from
// LAUNCH_ONLY_MESSAGE on purpose: nothing is being added to a waitlist here,
// and the home is already claimed.
export const OUT_OF_AREA_POST_MESSAGE =
  `Hearth pros serve ${LAUNCH_AREA_LABEL} right now, and this home is ` +
  "outside that area. We'll email you the moment we expand.";

// Which launch city each Orange County ZIP belongs to. Since 0129 this covers
// EVERY ZIP in ORANGE_COUNTY_ZIPS (the test asserts it), so isLaunchZip and
// isOrangeCountyZip now agree; the map still exists because the per-city half
// of the pro gate needs a city, not a boolean. The homeowner onboarding gate
// and the pro-side alert filter both read this; the DB gates read the
// identical mapping in public.launch_city_for_zip() (migration 0129, which
// replaced 0126's nine-city map), and src/lib/serviceArea.test.ts reads the
// .sql file to prove the two match.
//
// A ZIP maps to ONE city, so a ZIP shared by two places goes to the
// incorporated one: 92705 (Santa Ana / North Tustin) stays Santa Ana, 90720
// (Los Alamitos / Rossmoor) stays Los Alamitos, and 92679 (Coto de Caza /
// Dove Canyon / Robinson Ranch, the last two inside Rancho Santa Margarita's
// city limits) goes to Rancho Santa Margarita. That is why those three
// communities are not launch cities (see LAUNCH_COMMUNITIES above). Annexed
// and unincorporated pockets go to the city that surrounds or serves them:
// Sunset Beach (90742) to Huntington Beach, Surfside (90743) to Seal Beach,
// Corona del Mar (92625) and Newport Coast (92657) to Newport Beach,
// Capistrano Beach (92624) to Dana Point, Foothill Ranch (92610) to Lake
// Forest, Anaheim Hills (92807/92808) to Anaheim, Silverado / Modjeska
// (92676, reached by Santiago Canyon Road) to Orange, and Trabuco Canyon
// proper (92678) to Rancho Santa Margarita, the nearest city with pros.
//
// VERIFY THESE against the HUD crosswalk (same TODO as the set above): 92676
// and 92678 (canyon ZIPs no incorporated city contains, assigned by road
// access), 92885 (Yorba Linda, may be PO-box only), 92856 and 92864 (Orange,
// both small and one may be PO-box only), 92694 and 92832 (added in 0129 as
// missing residential ZIPs).
export const LAUNCH_CITY_BY_ZIP: Record<string, LaunchCityName> = {
  // Aliso Viejo
  "92656": "Aliso Viejo",
  // Anaheim, including Anaheim Hills (92807, 92808)
  "92801": "Anaheim",
  "92802": "Anaheim",
  "92804": "Anaheim",
  "92805": "Anaheim",
  "92806": "Anaheim",
  "92807": "Anaheim",
  "92808": "Anaheim",
  // Brea
  "92821": "Brea",
  "92823": "Brea",
  // Buena Park
  "90620": "Buena Park",
  "90621": "Buena Park",
  // Costa Mesa
  "92626": "Costa Mesa",
  "92627": "Costa Mesa",
  // Cypress
  "90630": "Cypress",
  // Dana Point, including Capistrano Beach (92624)
  "92624": "Dana Point",
  "92629": "Dana Point",
  // Fountain Valley
  "92708": "Fountain Valley",
  // Fullerton
  "92831": "Fullerton",
  "92832": "Fullerton",
  "92833": "Fullerton",
  "92835": "Fullerton",
  // Garden Grove
  "92840": "Garden Grove",
  "92841": "Garden Grove",
  "92843": "Garden Grove",
  "92844": "Garden Grove",
  "92845": "Garden Grove",
  // Huntington Beach, including Sunset Beach (90742)
  "92646": "Huntington Beach",
  "92647": "Huntington Beach",
  "92648": "Huntington Beach",
  "92649": "Huntington Beach",
  "90742": "Huntington Beach",
  // Irvine
  "92602": "Irvine",
  "92603": "Irvine",
  "92604": "Irvine",
  "92606": "Irvine",
  "92612": "Irvine",
  "92614": "Irvine",
  "92617": "Irvine",
  "92618": "Irvine",
  "92620": "Irvine",
  // La Habra
  "90631": "La Habra",
  // La Palma
  "90623": "La Palma",
  // Laguna Beach
  "92651": "Laguna Beach",
  // Laguna Hills
  "92653": "Laguna Hills",
  // Laguna Niguel
  "92677": "Laguna Niguel",
  // Laguna Woods
  "92637": "Laguna Woods",
  // Lake Forest, including Foothill Ranch (92610)
  "92610": "Lake Forest",
  "92630": "Lake Forest",
  // Los Alamitos (Rossmoor shares 90720)
  "90720": "Los Alamitos",
  // Mission Viejo
  "92691": "Mission Viejo",
  "92692": "Mission Viejo",
  // Newport Beach, including Corona del Mar (92625), Newport Coast (92657)
  // and Balboa Island (92662)
  "92625": "Newport Beach",
  "92657": "Newport Beach",
  "92660": "Newport Beach",
  "92661": "Newport Beach",
  "92662": "Newport Beach",
  "92663": "Newport Beach",
  // Orange, plus Silverado / Modjeska Canyon (92676) up Santiago Canyon Road
  "92676": "Orange",
  "92856": "Orange",
  "92864": "Orange",
  "92865": "Orange",
  "92866": "Orange",
  "92867": "Orange",
  "92868": "Orange",
  "92869": "Orange",
  // Placentia
  "92870": "Placentia",
  // Rancho Santa Margarita, including Dove Canyon and Robinson Ranch (92679,
  // shared with Coto de Caza) and Trabuco Canyon proper (92678)
  "92678": "Rancho Santa Margarita",
  "92679": "Rancho Santa Margarita",
  "92688": "Rancho Santa Margarita",
  // San Clemente
  "92672": "San Clemente",
  "92673": "San Clemente",
  // San Juan Capistrano
  "92675": "San Juan Capistrano",
  // Santa Ana (North Tustin shares 92705)
  "92701": "Santa Ana",
  "92703": "Santa Ana",
  "92704": "Santa Ana",
  "92705": "Santa Ana",
  "92706": "Santa Ana",
  "92707": "Santa Ana",
  // Seal Beach, including Surfside (90743)
  "90740": "Seal Beach",
  "90743": "Seal Beach",
  // Stanton
  "90680": "Stanton",
  // Tustin
  "92780": "Tustin",
  "92782": "Tustin",
  // Villa Park
  "92861": "Villa Park",
  // Westminster
  "92683": "Westminster",
  // Yorba Linda
  "92885": "Yorba Linda",
  "92886": "Yorba Linda",
  "92887": "Yorba Linda",
  // Ladera Ranch (unincorporated, its own single ZIP)
  "92694": "Ladera Ranch",
  // Midway City (unincorporated, its own single ZIP)
  "92655": "Midway City",
};

// Which launch city a ZIP belongs to, or null when it is none. Same
// normalization as isOrangeCountyZip (trim, first 5 characters) so a ZIP+4 or
// a padded value resolves the same way it does everywhere else.
export function launchCityForZip(zip: string): LaunchCityName | null {
  const normalized = (zip ?? "").trim().slice(0, 5);
  // hasOwnProperty, not a bare index: this reads a plain object with untrusted
  // input, and a bare lookup would happily return Object.prototype's members
  // for a crafted key. The 5-character slice happens to make that unreachable
  // today, which is exactly the kind of accident a future edit removes.
  return Object.prototype.hasOwnProperty.call(LAUNCH_CITY_BY_ZIP, normalized)
    ? LAUNCH_CITY_BY_ZIP[normalized]
    : null;
}

// True only for a ZIP inside the launch area. This is the gate homeowner
// onboarding uses; isOrangeCountyZip stays exported for the callers that ask
// the county question by name, and since 0129 the two return the same answer.
export function isLaunchZip(zip: string): boolean {
  return launchCityForZip(zip) !== null;
}
