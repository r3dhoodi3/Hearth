// Pure labelling helpers for the dashboard weather strip and its 7-day panel.
// Kept out of the component so they can be unit-tested without a DOM, and
// deliberately free of any lucide/React import: this module returns an icon
// KEY, and WeatherStrip owns the key -> icon map.

export type ConditionKey =
  | "sun"
  | "moon"
  | "cloudSun"
  | "cloudMoon"
  | "cloud"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm";

// Open-Meteo WMO weather codes -> one icon key and one short word. Buckets,
// not per-code labels: a homeowner glancing at the dashboard needs "Rain", not
// "moderate rain with slight hail". Unknown codes fall back to plain cloudy.
//
// isDay matters only for the clear/near-clear codes, because WMO 0/1/2 say
// nothing about daylight - which is why the strip used to claim "Sunny" at
// midnight. Everything overcast or worse looks the same after dark, so those
// buckets are shared. Daily rows have no day/night, so they pass isDay=true.
export function conditionFor(
  code: number,
  isDay: boolean
): { key: ConditionKey; word: string } {
  if (code === 0 || code === 1)
    return isDay
      ? { key: "sun", word: "Sunny" }
      : { key: "moon", word: "Clear" };
  if (code === 2)
    return isDay
      ? { key: "cloudSun", word: "Partly cloudy" }
      : { key: "cloudMoon", word: "Partly cloudy" };
  if (code === 3) return { key: "cloud", word: "Cloudy" };
  if (code === 45 || code === 48) return { key: "fog", word: "Foggy" };
  if (code >= 51 && code <= 57) return { key: "drizzle", word: "Drizzle" };
  if (code >= 61 && code <= 67) return { key: "rain", word: "Rain" };
  if (code >= 71 && code <= 77) return { key: "snow", word: "Snow" };
  if (code >= 80 && code <= 82) return { key: "rain", word: "Showers" };
  if (code === 85 || code === 86) return { key: "snow", word: "Snow" };
  if (code >= 95) return { key: "storm", word: "Storms" };
  return { key: "cloud", word: "Cloudy" };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "2026-08-23" -> "Sun". Open-Meteo is asked with timezone=auto, so each daily
// date is already a plain calendar date in the HOME's timezone. Handing that
// string to `new Date()` would parse it as UTC midnight and then render it in
// the BROWSER's timezone, which shifts the weekday back a day for anyone west
// of UTC - the exact bug this parses around by pinning the arithmetic to UTC
// on both ends.
export function weekdayShort(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const day = d.getUTCDay();
  return Number.isNaN(day) ? "" : WEEKDAYS[day];
}

// One calendar day later, as a plain YYYY-MM-DD string. UTC arithmetic on
// both ends for the same reason weekdayShort pins to UTC: these are calendar
// dates in the HOME's timezone, not instants, and letting the browser's
// offset near them shifts the answer by a day.
function nextDay(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Label one forecast row: "Today", "Tomorrow", or a short weekday.
//
// BY DATE, not by position. This used to call row 0 "Today" and row 1
// "Tomorrow" on the assumption that Open-Meteo's daily array always starts on
// the home's current local day. It usually does, but the route also drops any
// row whose numbers are incomplete, and the response is cached for half an
// hour across a midnight boundary: either one shifts every row up and the
// panel then labels tomorrow's forecast "Today", which is the one thing this
// strip must never get wrong. `today` is the home's own local date, taken from
// the same Open-Meteo payload (current.time), so a viewer in another timezone
// still reads the home's day correctly.
//
// With no usable `today` (an older cached payload), this falls back to plain
// weekday names rather than guessing which row is today: a real weekday is
// always true, where a wrong "Today" is not.
export function dayLabel(date: string, today?: string | null): string {
  if (today && date === today) return "Today";
  if (today && date === nextDay(today)) return "Tomorrow";
  return weekdayShort(date);
}
