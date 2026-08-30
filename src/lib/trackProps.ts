// Sanitizer for the props a browser beacon may attach to an analytics event.
//
// WHY. /api/track allowlists the event NAME but, until the 2026-08-30 red team
// (H3, low), stored whatever object came with it, up to 1 KB of anything: free
// text, another person's id, a URL with a token in it. docs/ANALYTICS.md's rule
// is "ids, enums and numbers only", and a rule the server does not enforce is
// a rule a script can ignore. This makes the storage layer enforce it.
//
// Shape kept: a flat object, at most MAX_KEYS keys, snake_case keys, and values
// that are finite numbers, booleans, or short strings drawn from the id / enum
// / route-pattern alphabet (uuids, "quote", "/pro/crm/:id", "web_vitals"). A
// value that fails is dropped on its own; the event still records with the
// keys that passed, so one bad field never loses a whole beacon.
export const MAX_KEYS = 12;
export const MAX_STRING = 64;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
// Letters, digits, and the punctuation ids and route patterns need. No spaces,
// no quotes, no angle brackets, no "@" (an email can never sit here), no "?"
// or "#" (a query string or fragment can never sit here).
const VALUE_RE = /^[A-Za-z0-9_\-:./]*$/;

export type TrackProps = Record<string, string | number | boolean>;

export function sanitizeTrackProps(input: unknown): TrackProps | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: TrackProps = {};
  let kept = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (kept >= MAX_KEYS) break;
    if (!KEY_RE.test(key)) continue;
    if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      // Web vitals are milliseconds or unitless ratios; nothing legitimate
      // needs more than a few decimals, and rounding keeps the row small.
      out[key] = Math.round(value * 1000) / 1000;
    } else if (typeof value === "string") {
      if (value.length > MAX_STRING || !VALUE_RE.test(value)) continue;
      out[key] = value;
    } else {
      // Nested objects, arrays, null: never stored.
      continue;
    }
    kept += 1;
  }
  return kept > 0 ? out : null;
}
