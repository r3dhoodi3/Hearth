// Orange County, California city names plus the matching logic behind the
// Service Area suggestions on the pro forms (onboarding + profile editor).
// service_area is stored as free text that can hold several cities separated
// by commas, so matching works on the token the pro is currently typing, not
// the whole field. Kept here (not in the pro form files) so the forms only
// need a light wire-up; see src/components/ServiceAreaInput.tsx.

// All 34 incorporated Orange County cities. `as const` (not `readonly
// string[]`) because src/lib/serviceArea.ts builds LAUNCH_CITY_NAMES and the
// LaunchCityName union from these two arrays: since the launch area became all
// of Orange County there is exactly one city list, and it lives here.
export const OC_INCORPORATED_CITIES = [
  "Aliso Viejo",
  "Anaheim",
  "Brea",
  "Buena Park",
  "Costa Mesa",
  "Cypress",
  "Dana Point",
  "Fountain Valley",
  "Fullerton",
  "Garden Grove",
  "Huntington Beach",
  "Irvine",
  "La Habra",
  "La Palma",
  "Laguna Beach",
  "Laguna Hills",
  "Laguna Niguel",
  "Laguna Woods",
  "Lake Forest",
  "Los Alamitos",
  "Mission Viejo",
  "Newport Beach",
  "Orange",
  "Placentia",
  "Rancho Santa Margarita",
  "San Clemente",
  "San Juan Capistrano",
  "Santa Ana",
  "Seal Beach",
  "Stanton",
  "Tustin",
  "Villa Park",
  "Westminster",
  "Yorba Linda",
] as const;

// Well-known unincorporated communities pros routinely list as service areas.
export const OC_COMMUNITIES = [
  "Ladera Ranch",
  "Coto de Caza",
  "North Tustin",
  "Midway City",
  "Rossmoor",
] as const;

// Incorporated cities first, then the communities. This order is the canonical
// one everywhere a city list is stored or compared (see LAUNCH_CITY_NAMES).
export const OC_CITIES = [
  ...OC_INCORPORATED_CITIES,
  ...OC_COMMUNITIES,
] as const;

// Shorthand the generated initials and name prefixes don't cover. Initials
// ("fv" for Fountain Valley, "rsm" for Rancho Santa Margarita) are derived
// programmatically below, so this map stays tiny: local nicknames only.
const MANUAL_ALIASES: Record<string, string> = {
  "el toro": "Lake Forest", // pre-1991 name, still in common use
  "surf city": "Huntington Beach",
  capo: "San Juan Capistrano",
};

function initialsOf(city: string): string {
  return city
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join("");
}

// Precomputed lowercase name + initials per city, in list order.
const CITY_INDEX = OC_CITIES.map((city) => ({
  city,
  lower: city.toLowerCase(),
  initials: initialsOf(city),
}));

// Suggestions for one typed token. Case-insensitive, three passes in
// priority order, deduped, capped at `limit`:
//   1. name prefix: "fou" -> Fountain Valley, "lag" -> the four Lagunas
//   2. initials prefix (2+ chars): "fv" -> Fountain Valley,
//      "hb" -> Huntington Beach, "rsm" -> Rancho Santa Margarita
//   3. manual alias prefix (2+ chars): "el t" -> Lake Forest
export function matchOcCities(rawQuery: string, limit = 6): string[] {
  const q = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];

  const results: string[] = [];
  const push = (city: string) => {
    if (results.length < limit && !results.includes(city)) results.push(city);
  };

  for (const entry of CITY_INDEX) {
    if (entry.lower.startsWith(q)) push(entry.city);
  }
  if (q.length >= 2 && /^[a-z]+$/.test(q)) {
    for (const entry of CITY_INDEX) {
      if (entry.initials.startsWith(q)) push(entry.city);
    }
  }
  if (q.length >= 2) {
    for (const [alias, city] of Object.entries(MANUAL_ALIASES)) {
      if (alias.startsWith(q)) push(city);
    }
  }
  return results;
}

// --- Token helpers -----------------------------------------------------
// service_area holds a comma-separated list ("Irvine, Tustin, ..."), so the
// suggestion UI only ever looks at the token around the caret.

const SEPARATORS = [",", ";", "/"];

// Boundaries of the token containing the caret, plus the query text typed so
// far (token start up to the caret, trimmed).
export function serviceAreaTokenAt(
  value: string,
  caret: number
): { start: number; end: number; query: string } {
  let start = 0;
  for (const sep of SEPARATORS) {
    const i = value.lastIndexOf(sep, Math.max(0, caret - 1));
    if (i >= 0 && i + 1 > start) start = i + 1;
  }
  let end = value.length;
  for (const sep of SEPARATORS) {
    const i = value.indexOf(sep, caret);
    if (i >= 0 && i < end) end = i;
  }
  // Guard: with the caret at 0 and a leading separator (",Irvine"), the
  // lastIndexOf above can land on the separator AT the caret and invert the
  // range (start=1, end=0). Clamp so start <= caret <= end always holds.
  if (start > caret) start = caret;
  if (end < caret) end = caret;
  return { start, end, query: value.slice(start, caret).trim() };
}

// Applies the chosen city to the token between start and end, keeping the
// rest of the field intact and returning where the caret should land.
// Normally the token is replaced outright, but when nothing has been typed
// yet (empty query) and the token span reaches past the caret into a
// downstream token ("Irvine, |Tustin"), replacing would eat that token, so
// the city is inserted at the caret instead. A single space is kept after a
// preceding "," or ";" so the list stays readable; "/" stays unpadded.
export function applyCitySuggestion(
  value: string,
  start: number,
  end: number,
  city: string,
  caret = end
): { value: string; caret: number } {
  const padAfter = (before: string) =>
    before.length > 0 && !before.endsWith(" ") && !before.endsWith("/")
      ? " "
      : "";

  if (caret < end && value.slice(start, caret).trim() === "") {
    // Insert mode: keep the downstream token, splicing the city in front of
    // it with a matching separator.
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const inserted = before + padAfter(before) + city;
    const sep = before.trimEnd().endsWith("/")
      ? "/"
      : after.startsWith(" ")
        ? ","
        : ", ";
    return { value: inserted + sep + after, caret: inserted.length };
  }

  const before = value.slice(0, start);
  const replaced = before + padAfter(before) + city;
  return {
    value: replaced + value.slice(end),
    caret: replaced.length,
  };
}
