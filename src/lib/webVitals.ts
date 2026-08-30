// Pure helpers behind the Web Vitals reporter (src/components/WebVitals.tsx).
// Split out so the sampling and route-normalizing logic can be unit tested
// without pulling in the "web-vitals" library or a browser.
//
// Payload rule (docs/ANALYTICS.md): ids and enums only, never free text. A
// full URL can carry a query string or, on a dynamic route, an id - so every
// report is keyed on a normalized ROUTE PATTERN ("/pro/crm/:id"), never
// location.pathname verbatim.

// One in ten page views reports vitals. Web Vitals reporting itself has a
// cost (a listener on every paint/layout-shift/interaction for the life of
// the page), so this is a sample of page views, not a filter applied after
// full-cost collection on every one.
export const WEB_VITALS_SAMPLE_RATE = 0.1;

export function shouldSampleWebVitals(random: () => number = Math.random): boolean {
  return random() < WEB_VITALS_SAMPLE_RATE;
}

export const WEB_VITALS_EVENT = "web_vitals" as const;

export type WebVitalName = "LCP" | "INP" | "CLS" | "TTFB";
export type WebVitalRating = "good" | "needs-improvement" | "poor";

const WEB_VITAL_NAMES: ReadonlySet<string> = new Set<WebVitalName>([
  "LCP",
  "INP",
  "CLS",
  "TTFB",
]);

export function isWebVitalName(name: string): name is WebVitalName {
  return WEB_VITAL_NAMES.has(name);
}

// A segment counts as a dynamic id (and is replaced with ":id") when it
// contains a digit or an uppercase character - a UUID, a short nanoid-style
// token (join/household/[token]), and an all-digit id all match this, while
// every static route segment in this app is a short, lowercase, hyphenated
// word ("home-details", "quote-check", "home-maintenance-schedule") that
// never contains either. Kept as one general rule rather than an enumerated
// list of every [param] route in the app, so a newly added dynamic route is
// covered automatically instead of silently reporting raw ids until someone
// remembers to list it here.
const DYNAMIC_SEGMENT = /[A-Z0-9]/;

export function normalizeRoutePattern(pathname: string): string {
  const [path] = pathname.split(/[?#]/);
  const segments = path.split("/").map((segment) => {
    if (segment.length === 0) return segment;
    return DYNAMIC_SEGMENT.test(segment) ? ":id" : segment;
  });
  return segments.join("/") || "/";
}

export type WebVitalsProps = {
  metric: WebVitalName;
  value: number;
  rating: WebVitalRating;
  path: string;
  // Fixed at WEB_VITALS_SAMPLE_RATE today, but carried on every row rather
  // than assumed: if the rate ever changes, past rows stay self-describing
  // instead of silently mixing two different weights under one query.
  sample_rate: number;
};

// CLS is a small unitless score (typically < 0.25); the other three are
// milliseconds. Rounding keeps the serialized props well under the route's
// 1024-char cap and drops sub-millisecond precision nobody queries by.
export function roundMetricValue(name: WebVitalName, value: number): number {
  return name === "CLS" ? Math.round(value * 1000) / 1000 : Math.round(value);
}

export function buildWebVitalsProps(
  name: WebVitalName,
  value: number,
  rating: WebVitalRating,
  pathname: string
): WebVitalsProps {
  return {
    metric: name,
    value: roundMetricValue(name, value),
    rating,
    path: normalizeRoutePattern(pathname),
    sample_rate: WEB_VITALS_SAMPLE_RATE,
  };
}
