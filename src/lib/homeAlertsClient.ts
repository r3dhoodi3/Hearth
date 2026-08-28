// Client-side helper for /api/home-alerts, shared by WeatherStrip (always-on
// current conditions at the top of the dashboard) and HomeAlerts (alert-only
// freeze/heat/recall list). Both mount on the same page, so without sharing
// they would each hit the route - and the route re-runs its Supabase reads on
// every call (it is deliberately uncached per user). A short module-level
// share window dedupes that into ONE fetch per page load while still
// refetching fresh data on a later navigation back to the dashboard. The
// cache is keyed by the active property's id: switching homes via
// HomeSwitcher soft-redirects to /dashboard without remounting, so a
// property change must bypass the share window or the new home would show
// the old home's weather for up to 30s.

export type HomeAlert = {
  kind: "freeze" | "heat" | "recall";
  title: string;
  detail: string;
  url?: string;
};

// One day of the 7-day panel the weather strip expands into. `date` is a plain
// calendar date in the HOME's timezone (Open-Meteo with timezone=auto), never
// an instant - see weatherLabels.dayLabel for why that distinction matters.
// Every number is nullable: the route keeps a row whenever it has a date and
// fills in nulls for whatever the upstream did not send, so rows never shift
// position (which is what used to make the panel mislabel a day). The strip
// renders a null as "--".
export type DailyForecast = {
  date: string;
  code: number | null;
  highF: number | null;
  lowF: number | null;
  rainPct: number | null;
};

export type CurrentWeather = {
  tempF: number;
  code: number;
  // Open-Meteo's is_day flag. WMO codes 0/1/2 mean "clear"/"partly cloudy"
  // with no notion of daylight, so without this the strip says "Sunny" at
  // midnight.
  isDay: boolean;
  highF: number;
  lowF: number;
  city: string;
  // The home's own current calendar date, so the 7-day panel can label rows
  // by DATE instead of by position. Optional because a payload cached before
  // this field existed will not carry it; dayLabel falls back to weekday
  // names rather than guessing which row is today.
  today?: string;
  // The IANA zone Open-Meteo geocoded for this home (its `timezone=auto`
  // response field), so the strip's clock can show the home's real local
  // time instead of always assuming the launch area's zone. Null when the
  // upstream lookup didn't return one; timeZoneForProperty falls back to a
  // state guess, then the launch area's zone, in that case.
  timezone: string | null;
  daily: DailyForecast[];
};

export type HomeAlertsPayload = {
  weather: HomeAlert[];
  recalls: HomeAlert[];
  current: CurrentWeather | null;
  // True when the active property has a resolvable location (city/state, or
  // a zip in the launch-city map), regardless of whether the upstream
  // weather lookup itself succeeded. WeatherStrip uses this to tell "no
  // weather because this home has no location" (show nothing) apart from
  // "no weather because the lookup failed" (show a quiet fallback).
  hasLocation: boolean;
};

let shared: {
  at: number;
  propertyId: string;
  promise: Promise<HomeAlertsPayload | null>;
} | null = null;

// Long enough that two components mounting in the same render share one call,
// short enough that revisiting the dashboard later gets fresh weather.
const SHARE_WINDOW_MS = 30_000;

// Resolves to null on any failure (network error, non-200, or the hard 6s
// timeout) - callers render nothing in that case, never an error state. The
// 6s cap lives here rather than per-caller so a shared in-flight promise has
// exactly one abort authority; consumers just stop listening on unmount.
export function fetchHomeAlerts(
  propertyId: string
): Promise<HomeAlertsPayload | null> {
  if (
    shared &&
    shared.propertyId === propertyId &&
    Date.now() - shared.at < SHARE_WINDOW_MS
  )
    return shared.promise;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  const promise: Promise<HomeAlertsPayload | null> = fetch("/api/home-alerts", {
    signal: controller.signal,
  })
    .then((r) => (r.ok ? (r.json() as Promise<HomeAlertsPayload>) : null))
    .catch(() => null)
    .finally(() => clearTimeout(timeout));
  shared = { at: Date.now(), propertyId, promise };
  return promise;
}
