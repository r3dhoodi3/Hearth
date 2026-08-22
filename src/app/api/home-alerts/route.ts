import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { SYSTEM_TYPES, labelFor } from "@/lib/constants";
import { assessSystem } from "@/lib/health";
import { STATE_NAMES } from "@/lib/forecast";

export const runtime = "nodejs";

// Two proactive "Google can't do this for YOUR home" feeds, behind one call so
// the dashboard stays fast and degrades gracefully:
//  - weather: freeze/heat warnings from a free, keyless forecast (Open-Meteo),
//    tailored to the homeowner's actual systems and their ages.
//  - recalls: best-effort safety-recall matches for their stored appliance
//    brands (CPSC SaferProducts), clearly labelled "verify".
// Anything slow or unavailable just yields an empty list - never an error page.

type Alert = {
  kind: "freeze" | "heat" | "recall";
  title: string;
  detail: string;
  url?: string;
};

// Small "weather app" snapshot for the dashboard's always-on strip. Rides on
// the SAME Open-Meteo forecast call the freeze/heat alerts already make (the
// `current=` params below), so it costs zero extra upstream requests. Null
// whenever anything about the lookup fails - the strip renders nothing then.
type CurrentWeather = {
  tempF: number;
  code: number;
  highF: number;
  lowF: number;
  city: string;
};

// revalidateSec, when given, lets Next's fetch data cache serve repeat calls
// to the SAME upstream URL without re-hitting the third-party API - this is
// a per-URL cache on the outgoing fetch, not on this route's own response
// (the route stays uncached, see the GET handler below), and it never touches
// Supabase data, so it can't leak one homeowner's info to another: the only
// thing cached is a public geocode/forecast/recall payload keyed by its own
// request URL (which already encodes the city/coords/brand query params).
async function fetchJson(
  url: string,
  ms: number,
  revalidateSec?: number
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
      ...(revalidateSec
        ? { next: { revalidate: revalidateSec } }
        : { cache: "no-store" as const }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// True when an Open-Meteo geocoding result sits in the property's US state.
// admin1 comes back as the full state name ("Illinois"), while properties
// usually store the two-letter code, so compare against both forms. Same
// logic as cron/alerts/route.ts's matchesState, duplicated here rather than
// shared since it's a few lines and each caller is otherwise independent.
function matchesState(result: any, state: string): boolean {
  const admin1 = typeof result?.admin1 === "string" ? result.admin1.toLowerCase() : "";
  if (!admin1) return false;
  const wanted = state.trim();
  const fullName = STATE_NAMES[wanted.toUpperCase()] ?? "";
  return (
    admin1 === wanted.toLowerCase() ||
    (fullName !== "" && admin1 === fullName.toLowerCase())
  );
}

function whenLabel(i: number): string {
  if (i <= 0) return "today";
  if (i === 1) return "tomorrow";
  return `in ${i} days`;
}

// No route-segment caching here: the response is scoped to the signed-in
// user's active property (getActiveProperty reads the session), so a shared
// `revalidate` would serve one homeowner's weather/recall data to the next
// caller. Instead, the independent external calls below run concurrently
// (the weather leg and the recalls leg via Promise.all, and the up to 4 CPSC
// brand lookups inside the recalls leg via their own Promise.all) so a slow
// upstream costs latency once, not once per call.
export async function GET() {
  const empty = NextResponse.json({ weather: [], recalls: [], current: null });
  let property: any = null;
  let systems: any[] = [];
  try {
    property = await getActiveProperty();
    if (!property) return empty;
    const supabase = await createClient();
    const { data } = await supabase
      .from("home_systems")
      .select("system_type, install_year, material_or_model, condition_rating")
      .eq("property_id", property.id);
    systems = data ?? [];
  } catch {
    return empty;
  }

  const [{ alerts: weather, current }, recalls] = await Promise.all([
    fetchWeather(property, systems),
    fetchRecalls(systems),
  ]);

  return NextResponse.json({ weather, recalls, current });
}

// --- Weather (Open-Meteo, no key) ---
async function fetchWeather(
  property: any,
  systems: any[]
): Promise<{ alerts: Alert[]; current: CurrentWeather | null }> {
  const weather: Alert[] = [];
  let current: CurrentWeather | null = null;
  try {
    const place = [property.city, property.state].filter(Boolean).join(", ");
    if (place) {
      // Geocoding: an address string always resolves to the same coordinates,
      // so this is cached for a full day. But Open-Meteo's geocoder ranks
      // bare-name matches by global prominence, not by US state ("Springfield"
      // alone returns Springfield, MO ahead of Springfield, IL) - and it does
      // NOT understand a comma-separated "City, State" in the name param
      // (verified live: that query returns zero results), so the state can't
      // be folded into `name` to disambiguate. Instead: ask for several US
      // candidates and pick the one whose admin1 matches property.state.
      // Next's fetch cache is keyed on the request URL, so without the state
      // somewhere in that URL, Springfield-IL and Springfield-MO homes would
      // still collide on the SAME cached (wrong-for-one-of-them) top match for
      // 24h even though selection below is correct. `hearthState` is not a
      // real Open-Meteo parameter - the API ignores it (verified live: adding
      // it returns identical results) - it exists purely to partition the
      // cache key per state so each state gets its own cached response.
      const stateParam = property.state
        ? `&hearthState=${encodeURIComponent(property.state)}`
        : "";
      const geo = await fetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
          property.city
        )}&count=10&language=en&format=json&countryCode=US${stateParam}`,
        4000,
        86400 // 24h: address -> coords never changes
      );
      const usResults: any[] = Array.isArray(geo?.results)
        ? geo.results.filter((r: any) => r?.country_code === "US")
        : [];
      const loc = property.state
        ? usResults.find((r) => matchesState(r, property.state))
        : usResults[0];
      if (loc) {
        // Forecast: cached 30 min. Keyed on lat/lon straight from the geocode
        // result (already quantized by Open-Meteo's geocoder, so this doesn't
        // fragment the cache across near-identical coordinates for the same
        // city), so two homeowners in the same city share one upstream call.
        // `current=temperature_2m,weather_code` piggybacks the dashboard's
        // weather strip onto this same request: one upstream call feeds both
        // the freeze/heat alerts (daily arrays) and the current-conditions
        // snapshot. The 30 min cache means "current" can lag by up to that
        // much, which is fine for a glanceable temperature.
        const fc = await fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
            `&daily=temperature_2m_min,temperature_2m_max&current=temperature_2m,weather_code` +
            `&forecast_days=4&temperature_unit=fahrenheit&timezone=auto`,
          4000,
          1800 // 30 min
        );
        const mins: number[] = fc?.daily?.temperature_2m_min ?? [];
        const maxs: number[] = fc?.daily?.temperature_2m_max ?? [];

        // Today's snapshot for the strip. Only assembled when every piece is
        // a real number - a partial reading renders as nothing, not as NaN.
        const nowTemp = fc?.current?.temperature_2m;
        const nowCode = fc?.current?.weather_code;
        if (
          typeof nowTemp === "number" &&
          typeof nowCode === "number" &&
          typeof maxs[0] === "number" &&
          typeof mins[0] === "number"
        ) {
          current = {
            tempF: Math.round(nowTemp),
            code: nowCode,
            highF: Math.round(maxs[0]),
            lowF: Math.round(mins[0]),
            city: property.city ?? loc.name ?? "",
          };
        }

        // System context for tailored advice.
        const plumbing = systems.find((s) =>
          ["plumbing", "sewer_line"].includes(s.system_type)
        );
        const hvac = systems.find((s) => s.system_type === "hvac");
        const plumbingAge = plumbing ? assessSystem(plumbing).age : null;
        const hvacAge = hvac ? assessSystem(hvac).age : null;

        // Earliest freeze in the window.
        const fi = mins.findIndex((t) => t != null && t <= 32);
        if (fi !== -1) {
          weather.push({
            kind: "freeze",
            title: `Freeze coming ${whenLabel(fi)} (${Math.round(mins[fi])}°F)`,
            detail:
              "Let indoor faucets drip overnight, disconnect garden hoses, and open cabinet doors under sinks." +
              (plumbingAge && plumbingAge >= 40
                ? ` Your plumbing is about ${plumbingAge} yrs old, so older pipes are extra vulnerable to bursting.`
                : ""),
          });
        }

        // Earliest serious heat in the window.
        const hi = maxs.findIndex((t) => t != null && t >= 95);
        if (hi !== -1) {
          weather.push({
            kind: "heat",
            title: `Heat wave ${whenLabel(hi)} (${Math.round(maxs[hi])}°F)`,
            detail:
              "Change your AC filter, keep blinds closed during the day, and don't set the thermostat too low (it overworks the unit)." +
              (hvacAge && hvacAge >= 15
                ? ` Your AC is about ${hvacAge} yrs old. Watch for weak airflow or short-cycling on the hottest days.`
                : ""),
          });
        }
      }
    }
  } catch {
    /* leave weather empty */
  }
  return { alerts: weather, current };
}

// --- Recalls (CPSC SaferProducts, no key) ---
async function fetchRecalls(systems: any[]): Promise<Alert[]> {
  const recalls: Alert[] = [];
  try {
    // Keywords that must co-occur with a brand name for a recall to count as a
    // real match for that system. This stops a brand that is also a common word
    // (e.g. "Carrier" HVAC vs a baby/plate "carrier") from dragging in dozens of
    // unrelated recalls. A system type with no keywords falls back to brand-only.
    const SYSTEM_KEYWORDS: Record<string, string[]> = {
      hvac: [
        "furnace", "air condition", "heat pump", "hvac", "ac unit",
        "boiler", "thermostat", "heater", "condenser", "cooling", "heating",
      ],
      water_heater: ["water heater", "tankless", "boiler"],
      roof: ["roof", "shingle", "gutter", "skylight"],
      windows: ["window"],
      electrical_panel: ["electrical panel", "breaker", "circuit", "panel", "wiring", "load center"],
      plumbing: ["plumbing", "faucet", "valve", "pipe", "water supply", "toilet"],
      sewer_line: ["sewer", "septic", "sump"],
      appliance: [
        "dishwasher", "refrigerator", "washer", "dryer", "oven", "range",
        "microwave", "stove", "freezer", "cooktop", "washing machine",
      ],
    };

    // Build a small set of brand keywords from stored models, capped to keep
    // this fast. Only systems where the owner actually entered a brand/model.
    const brands = new Map<string, { label: string; type: string }>();
    for (const s of systems) {
      const model: string = (s.material_or_model ?? "").trim();
      if (!model) continue;
      const brand = model.split(/[\s,/]+/)[0];
      if (brand.length < 3) continue;
      const key = brand.toLowerCase();
      if (!brands.has(key))
        brands.set(key, {
          label: labelFor(SYSTEM_TYPES, s.system_type),
          type: s.system_type,
        });
      if (brands.size >= 4) break;
    }

    // Fetch every brand's CPSC results concurrently instead of one at a
    // time - up to 4 lookups at FETCH_TIMEOUT_MS each is the bulk of this
    // route's latency otherwise. This can fetch one or two more brands than
    // strictly needed if an early brand alone would have filled the 3-recall
    // cap, but that's a fair trade for not paying the timeout serially; the
    // selection below still processes brands in the same order and keeps the
    // same first-3-matches result.
    // CPSC recalls: cached a day per brand query URL. New recalls post
    // infrequently, and the key is the brand string, so this is shared across
    // every homeowner who happens to have the same appliance brand - never
    // anything user-specific.
    const brandEntries = Array.from(brands.entries());
    const brandResults = await Promise.all(
      brandEntries.map(([brand]) =>
        fetchJson(
          `https://www.saferproducts.gov/RestWebServices/Recall?format=json&ProductName=${encodeURIComponent(
            brand
          )}`,
          4000,
          86400 // 24h
        )
      )
    );

    const seen = new Set<string>();
    for (let i = 0; i < brandEntries.length; i++) {
      const [brand, { label: sysLabel, type: sysType }] = brandEntries[i];
      const data = brandResults[i];
      if (!Array.isArray(data)) continue;
      const keywords = SYSTEM_KEYWORDS[sysType] ?? [];
      for (const rec of data.slice(0, 20)) {
        const title: string =
          rec?.Title ?? rec?.RecallTitle ?? rec?.Description ?? "";
        if (!title) continue;
        const lower = title.toLowerCase();
        // Conservative: only keep recalls whose text actually names the brand.
        if (!lower.includes(brand)) continue;
        // And, when we know what this system is, that also read like that
        // system, not an unrelated product that shares the brand word.
        if (keywords.length && !keywords.some((k) => lower.includes(k)))
          continue;
        const url: string | undefined = rec?.URL ?? rec?.Url ?? undefined;
        const dedupe = (url ?? title).slice(0, 120);
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const date: string = (rec?.RecallDate ?? "").slice(0, 10);
        recalls.push({
          kind: "recall",
          title: title.length > 140 ? title.slice(0, 137) + "…" : title,
          detail:
            `Possible match for your ${sysLabel}${
              date ? ` · recalled ${date}` : ""
            }. Check the model/serial against the official notice to confirm.`,
          url,
        });
        if (recalls.length >= 3) break;
      }
      if (recalls.length >= 3) break;
    }
  } catch {
    /* leave recalls empty */
  }

  return recalls;
}
