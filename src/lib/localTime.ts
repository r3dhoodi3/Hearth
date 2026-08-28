// Local-time helpers for the weather strip's clock: which IANA zone a
// property sits in, and how to print a Date in that zone as a plain
// "3:42 PM" string. Both are pure and synchronous, so a component can call
// them straight from render without an effect of their own.

// Launch area is Orange County, CA, so this is also the fallback for a home
// with no location signal at all (no timezone on the payload, no state on
// the property).
const DEFAULT_ZONE = "America/Los_Angeles";

// Majority zone per US state/territory. A handful of states straddle two
// zones (FL panhandle, TX far-west El Paso, the ND/SD/KS/NE/MI/KY splits) -
// each is filed under whichever zone holds most of that state's population,
// since a zip-to-zone lookup isn't available here to disambiguate further.
const STATE_ZONES: Record<string, string> = {
  // Pacific
  CA: "America/Los_Angeles",
  WA: "America/Los_Angeles",
  OR: "America/Los_Angeles",
  NV: "America/Los_Angeles",
  // Mountain (Arizona does not observe DST, so it gets its own zone rather
  // than sharing America/Denver)
  AZ: "America/Phoenix",
  MT: "America/Denver",
  CO: "America/Denver",
  UT: "America/Denver",
  NM: "America/Denver",
  ID: "America/Denver",
  WY: "America/Denver",
  // Central
  TX: "America/Chicago",
  OK: "America/Chicago",
  KS: "America/Chicago",
  NE: "America/Chicago",
  SD: "America/Chicago",
  ND: "America/Chicago",
  MN: "America/Chicago",
  IA: "America/Chicago",
  MO: "America/Chicago",
  AR: "America/Chicago",
  LA: "America/Chicago",
  MS: "America/Chicago",
  AL: "America/Chicago",
  TN: "America/Chicago",
  WI: "America/Chicago",
  IL: "America/Chicago",
  // Eastern
  ME: "America/New_York",
  NH: "America/New_York",
  VT: "America/New_York",
  MA: "America/New_York",
  RI: "America/New_York",
  CT: "America/New_York",
  NY: "America/New_York",
  NJ: "America/New_York",
  PA: "America/New_York",
  DE: "America/New_York",
  MD: "America/New_York",
  DC: "America/New_York",
  VA: "America/New_York",
  WV: "America/New_York",
  NC: "America/New_York",
  SC: "America/New_York",
  GA: "America/New_York",
  FL: "America/New_York",
  OH: "America/New_York",
  MI: "America/New_York",
  IN: "America/New_York",
  KY: "America/New_York",
  // Alaska / Hawaii
  AK: "America/Anchorage",
  HI: "Pacific/Honolulu",
};

export type PropertyLocation = {
  // Two-letter US state code, e.g. "CA". Only used when `tz` isn't given.
  state?: string | null;
  // Not used to resolve a zone directly (a zip-to-zone table isn't wired up
  // here), but accepted so a caller with a property record can pass its
  // fields through without picking them apart first.
  zip?: string | null;
  // A real IANA zone straight from a geocoded source (the weather payload's
  // upstream forecast call, or the property record itself), when one is
  // available. Always wins over the state guess below.
  tz?: string | null;
};

// True when Intl accepts `zone` as a real IANA identifier. Constructing a
// DateTimeFormat with a bad zone throws, and that's the only reliable way to
// check - there's no separate "is this a valid zone" API.
function isValidZone(zone: string): boolean {
  try {
    // eslint-disable-next-line no-new -- constructing is the validity check
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Picks the IANA zone for a property. Preference order: a timezone already
// resolved upstream (most accurate - a real geocoded zone, not a guess),
// then the property's state mapped through STATE_ZONES, then the launch
// area's own zone as the last resort for a home with no location info at
// all. A malformed `tz` (typo, upstream garbage) is treated as absent rather
// than trusted blindly.
export function timeZoneForProperty(location: PropertyLocation): string {
  const tz = location.tz?.trim();
  if (tz && isValidZone(tz)) return tz;
  const code = location.state?.trim().toUpperCase();
  if (code && STATE_ZONES[code]) return STATE_ZONES[code];
  return DEFAULT_ZONE;
}

// "3:42 PM" for `date` in `zone`. Falls back to the default launch-area zone
// if `zone` isn't a real IANA identifier, so a bad value from upstream never
// crashes the strip - it just shows the wrong (but real) time instead of no
// time at all. Intl can format the meridiem with a narrow no-break space
// (U+202F) rather than a plain one depending on the ICU data available in
// the runtime, so that gets normalized to a regular space here to keep the
// output predictable for callers and tests.
export function formatLocalTime(date: Date, zone: string): string {
  const safeZone = isValidZone(zone) ? zone : DEFAULT_ZONE;
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: safeZone,
  }).format(date);
  return formatted.replace(/[\u202F\u00A0]/g, " ");
}
