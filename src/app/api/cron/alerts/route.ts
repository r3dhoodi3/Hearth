import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { STATE_NAMES } from "@/lib/forecast";

export const runtime = "nodejs";

// Scheduled job (Vercel Cron / Supabase scheduled function) that turns the
// weather alerts already computed for the dashboard (see home-alerts/route.ts)
// into rows in `notifications`, so a homeowner who isn't actively looking at
// the dashboard still gets re-engaged. Safe to run repeatedly: it dedupes on
// (user_id, kind) within a trailing window before inserting. The title is
// deliberately NOT part of the key: it embeds the relative day ("tomorrow")
// and rounded temperature, both of which change run to run for the same
// freeze/heat event, so keying on it would notify daily for one cold snap.
//
// Recalls are intentionally left to the dashboard's home-alerts call for now -
// they're per-brand and slower to fetch for every property on a schedule.
// This endpoint focuses on the fast, cheap wins: freeze, heat, high-wind
// (Santa Ana), and heavy-rain warnings, all off the one Open-Meteo forecast.

const DAY_MS = 24 * 60 * 60 * 1000;
// Covers the full 4-day forecast horizon, so a single event first spotted
// "in 3 days" can never re-notify as it walks in to "today".
const DEDUPE_WINDOW_MS = 4 * DAY_MS;
const FETCH_TIMEOUT_MS = 4000;
const MAX_PROPERTIES = 200; // cap the work a single run does
// Each property costs two external fetches (geocode + forecast) at
// FETCH_TIMEOUT_MS apiece, so a fully sequential run could take MAX_PROPERTIES
// x 2 x FETCH_TIMEOUT_MS worst case - well past any serverless timeout. Keep
// the fan-out bounded instead of unbounded Promise.all-ing the whole page.
const SEND_CHUNK = 10;

type WeatherAlert = {
  kind: "freeze" | "heat" | "high_wind" | "heavy_rain";
  title: string;
  body: string;
};

// Gust and rainfall thresholds that make an alert worth a homeowner's
// attention. 40 mph gusts are the low end of a Santa Ana / high-wind advisory
// (branches down, shingles and patio covers at risk); 1 inch of forecast rain
// in a day is enough for gutters and drainage to matter in normally dry SoCal.
const HIGH_WIND_MPH = 40;
const HEAVY_RAIN_INCHES = 1;

async function fetchJson(url: string, ms: number): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function whenLabel(i: number): string {
  if (i <= 0) return "today";
  if (i === 1) return "tomorrow";
  return `in ${i} days`;
}

// True when an Open-Meteo geocoding result sits in the property's US state.
// admin1 comes back as the full state name ("California"), while properties
// usually store the two-letter code, so compare against both forms.
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

// Reuses the Open-Meteo logic from home-alerts, trimmed to the single top
// weather alert and without the per-system age tailoring, to keep the cron
// cheap. Priority order when several conditions land in the same forecast:
// freeze first (burst pipes are the costliest surprise), then high wind and
// heavy rain (acute property damage that rewards acting before it hits), then
// heat (comfort and efficiency). Each kind dedupes independently downstream.
async function topWeatherAlert(
  city: string | null,
  state: string | null
): Promise<WeatherAlert | null> {
  const place = [city, state].filter(Boolean).join(", ");
  if (!city || !place) return null;

  // Open-Meteo ranks bare-name matches globally by prominence ("Venice" is
  // Venice, Italy; "Glendale" is the bigger Glendale, AZ), so ask for several
  // US candidates and pick the one in the property's state. A property with
  // no state on file falls back to the top US match; a property whose state
  // matches nothing is skipped rather than alerted for the wrong place.
  const geo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      city
    )}&count=10&language=en&format=json&countryCode=US`,
    FETCH_TIMEOUT_MS
  );
  const results: any[] = Array.isArray(geo?.results) ? geo.results : [];
  const usResults = results.filter((r) => r?.country_code === "US");
  const loc = state
    ? usResults.find((r) => matchesState(r, state))
    : usResults[0];
  if (!loc) return null;

  const fc = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&daily=temperature_2m_min,temperature_2m_max,wind_gusts_10m_max,precipitation_sum` +
      `&forecast_days=4&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`,
    FETCH_TIMEOUT_MS
  );
  const mins: number[] = fc?.daily?.temperature_2m_min ?? [];
  const maxs: number[] = fc?.daily?.temperature_2m_max ?? [];
  const gusts: number[] = fc?.daily?.wind_gusts_10m_max ?? [];
  const rain: number[] = fc?.daily?.precipitation_sum ?? [];

  const fi = mins.findIndex((t) => t != null && t <= 32);
  if (fi !== -1) {
    return {
      kind: "freeze",
      title: `Freeze coming ${whenLabel(fi)} (${Math.round(mins[fi])}°F)`,
      body: "Let indoor faucets drip overnight, disconnect garden hoses, and open cabinet doors under sinks.",
    };
  }

  const gi = gusts.findIndex((g) => g != null && g >= HIGH_WIND_MPH);
  if (gi !== -1) {
    return {
      kind: "high_wind",
      title: `High winds ${whenLabel(gi)} (gusts to ${Math.round(gusts[gi])} mph)`,
      body: "Santa Ana winds are picking up. Bring in or tie down patio furniture and umbrellas, and check that your roof shingles and gutters are secure before the strongest gusts.",
    };
  }

  const ri = rain.findIndex((p) => p != null && p >= HEAVY_RAIN_INCHES);
  if (ri !== -1) {
    return {
      kind: "heavy_rain",
      title: `Heavy rain ${whenLabel(ri)} (${rain[ri].toFixed(1)}" expected)`,
      body: "Clear your gutters and downspouts, make sure water drains away from the house, and check any spot that has leaked before so a small drip doesn't become a stain.",
    };
  }

  const hi = maxs.findIndex((t) => t != null && t >= 95);
  if (hi !== -1) {
    return {
      kind: "heat",
      title: `Heat wave ${whenLabel(hi)} (${Math.round(maxs[hi])}°F)`,
      body: "Change your AC filter, keep blinds closed during the day, and don't set the thermostat too low.",
    };
  }

  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // the CRON_SECRET env var is set. Also accept an explicit x-cron-secret header
  // for manual runs / other schedulers.
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const provided = bearer ?? req.headers.get("x-cron-secret");
  if (!provided) return false;
  // Constant-time compare (mirrors src/lib/checkr.ts / the twilio inbound
  // webhook): only call timingSafeEqual once both buffers are a confirmed
  // equal length, since it throws on a length mismatch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  let created = 0;

  // Housekeeping FIRST, before any of the early returns below.
  //
  // This used to sit at the bottom of the function, which meant it only ran on
  // the happy path: a properties count that errored, or an instance with no
  // properties at all, returned before reaching it, and the prune silently
  // never happened. Those are exactly the states where nobody is watching, so
  // the table would grow unbounded while the cron reported success every day.
  // It depends on nothing above it, so it belongs where it always runs.
  //
  // public.rate_limits (migration 0070) is append-only by design - rate_limit_hit
  // inserts a row per (bucket, window) and nothing ever deletes one. Every AI
  // request, burst window, and per-user daily bucket leaves a row behind
  // forever, so the table grows without bound and the lookups that read it
  // (askRemaining, the refund path) get slower for no reason. Nothing reads a
  // window older than a day; a week of slack keeps recent history around for
  // debugging an abuse report. Failure here is never fatal to the cron, but it
  // IS logged: a prune that has been failing for a month is worth knowing
  // about, and swallowing the error silently is how it stays unknown.
  try {
    const cutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const { error: pruneError } = await supabase
      .from("rate_limits")
      .delete()
      .lt("window_start", cutoff);
    if (pruneError) {
      console.error("alerts cron: rate_limits prune failed:", pruneError.message);
    }
  } catch (err) {
    // Pruning is maintenance, never the point of this run.
    console.error("alerts cron: rate_limits prune threw:", err);
  }

  // Every property gets its turn: with no ordering, a bare .limit() would
  // return the same de facto fixed rows every run and silently never
  // weather-check anything past MAX_PROPERTIES. Instead, count the rows,
  // order deterministically, and rotate a MAX_PROPERTIES-wide window by the
  // day number, so every property is visited within ceil(N/200) days without
  // any persisted cursor.
  const { count, error: countError } = await supabase
    .from("properties")
    .select("id", { count: "exact", head: true })
    .not("user_id", "is", null);
  if (countError) {
    return NextResponse.json(
      { created: 0, error: countError.message },
      { status: 200 }
    );
  }
  if (!count) {
    return NextResponse.json({ created: 0 });
  }
  const pages = Math.ceil(count / MAX_PROPERTIES);
  const page = Math.floor(Date.now() / DAY_MS) % pages;
  const from = page * MAX_PROPERTIES;

  const { data: properties, error } = await supabase
    .from("properties")
    .select("id, user_id, city, state")
    .not("user_id", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, from + MAX_PROPERTIES - 1);

  if (error || !properties) {
    return NextResponse.json({ created: 0, error: error?.message ?? "no properties" }, { status: 200 });
  }

  // Honor the "Weather and safety alerts" toggle on /account/notifications
  // (the `alerts` key in users.notification_prefs; an unset preference reads
  // as enabled, matching NotificationPrefsForm). Checked up front, before the
  // per-property Open-Meteo fetches, so opted-out homes cost nothing.
  const userIds = Array.from(
    new Set(properties.map((p) => p.user_id as string))
  );
  const optedOut = new Set<string>();
  // Contact details ride the SAME query as the prefs (no extra round trip),
  // so weather alerts can actually go out by email/SMS once the providers
  // are configured - which is what the /plus table sells for these kinds.
  // sendNotification's Plus gate decides per recipient whether the outbound
  // channels fire; sms_consent is the TCPA gate and must be the real column.
  const contactByUser = new Map<
    string,
    { email: string | null; phone: string | null; smsConsent: boolean | null }
  >();
  const { data: prefUsers } = await supabase
    .from("users")
    .select("id, notification_prefs, email, phone, sms_consent")
    .in("id", userIds);
  for (const u of prefUsers ?? []) {
    if ((u.notification_prefs as any)?.alerts === false) optedOut.add(u.id);
    contactByUser.set(u.id, {
      email: (u as any).email ?? null,
      phone: (u as any).phone ?? null,
      smsConsent: (u as any).sms_consent === true,
    });
  }

  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  for (const batch of chunk(properties, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (property) => {
        try {
          if (optedOut.has(property.user_id as string)) return;

          const alert = await topWeatherAlert(property.city, property.state);
          if (!alert) return;

          // Dedupe: skip if the same kind of alert already went out to this
          // user recently, so re-running the cron (or the same freeze/heat
          // event walking closer day by day) doesn't spam a warning every
          // run. The title is intentionally not matched: it changes every
          // run for the same event (see header comment).
          const { data: existing } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", property.user_id)
            .eq("kind", alert.kind)
            .gt("created_at", since)
            .limit(1);
          if (existing && existing.length > 0) return;

          // Routed through sendNotification (not a raw insert) so this cron
          // gets the same email/SMS-once-configured path as every other
          // notification source. Contact details come from the prefs query
          // above; the Plus gate inside sendNotification decides whether the
          // outbound channels actually fire for this recipient.
          const contact = contactByUser.get(property.user_id as string);
          const sent = await sendNotification(supabase, {
            userId: property.user_id as string,
            kind: alert.kind,
            title: alert.title,
            body: alert.body,
            url: "/dashboard",
            email: contact?.email ?? null,
            phone: contact?.phone ?? null,
            smsConsent: contact?.smsConsent ?? null,
          });
          if (sent) created += 1;
        } catch {
          // One property's failure shouldn't stop the rest of the batch.
        }
      })
    );
  }

  return NextResponse.json({ created });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
