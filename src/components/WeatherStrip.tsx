"use client";

import { useEffect, useState } from "react";
import {
  Sun,
  Moon,
  Cloud,
  CloudSun,
  CloudMoon,
  CloudRain,
  CloudDrizzle,
  CloudSnow,
  CloudFog,
  CloudLightning,
  ChevronDown,
  Droplets,
  type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/components/Skeleton";
import { fetchHomeAlerts, type CurrentWeather } from "@/lib/homeAlertsClient";
import {
  conditionFor,
  dayLabel,
  type ConditionKey,
} from "@/lib/weatherLabels";

// The word/icon buckets themselves live in @/lib/weatherLabels (pure, tested).
// This map is the only part that needs lucide, so the labelling stays testable
// in a plain node environment.
const ICONS: Record<ConditionKey, LucideIcon> = {
  sun: Sun,
  moon: Moon,
  cloudSun: CloudSun,
  cloudMoon: CloudMoon,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
};

// Below this, a rain chance is noise rather than information, so the row just
// leaves it off instead of printing "3%".
const RAIN_FLOOR = 10;

// One quiet row of current weather at the top of the dashboard: temperature,
// condition, today's high/low, city. Tapping it expands the week ahead in
// place. Always shown when data arrives (unlike HomeAlerts below it, which
// stays alert-only). Shares one /api/home-alerts fetch with HomeAlerts via
// fetchHomeAlerts, and follows the same skeleton contract: a placeholder only
// while the page itself is still loading, then nothing at all if the lookup
// fails - never a stuck or empty box.
// propertyId comes from the dashboard server component: switching homes via
// HomeSwitcher soft-redirects here without remounting, so the effect below
// keys on it to refetch for the new home instead of showing stale weather.
//
// HARD_DEADLINE_MS is the sole ceiling on the skeleton: fetchHomeAlerts
// already caps itself at 6s, so 8s here is purely a second, independent
// backstop - ending the skeleton on its own even if something upstream of
// that promise (hydration, anything) never settles.
//
// This used to also be gated on a `pageLoaded` flag (true once
// document.readyState / window's "load" fired), meant to give up on the
// skeleton once the page had visibly finished loading. That flag is a
// per-DOCUMENT signal, not a per-NAVIGATION one: after the first hard load
// of the session it stays true for good, so every later client-side
// navigation back to /dashboard (including the redirect from the profile
// menu's side switcher) mounted a fresh WeatherStrip with `pageLoaded`
// already true - collapsing the skeleton before fetchHomeAlerts had any
// realistic chance to resolve, and falling straight through to "no weather
// yet" (rendered as nothing). A hard load rarely hit this because window's
// "load" event fires late enough that the fetch had usually already
// finished by then; a soft navigation always started from "already loaded",
// so the strip skipped straight past the skeleton and could sit empty for
// the length of the fetch. Simply keying the skeleton on `loading` alone -
// with HARD_DEADLINE_MS as the only ceiling - fixes that for both cases.
const HARD_DEADLINE_MS = 8_000;

export default function WeatherStrip({ propertyId }: { propertyId: string }) {
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  // Whether the active property has a resolvable location at all, per the
  // route's own hasLocation flag - independent of whether the weather lookup
  // itself succeeded. Lets "no weather because this home has no location"
  // (render nothing) read differently from "no weather because the lookup
  // failed" (render a quiet fallback). Defaults false, which is also the
  // right fallback when the whole fetch errors out and we never get a
  // payload to read a real value from: rendering nothing is the safe choice
  // when the strip can't tell the two cases apart.
  const [hasLocation, setHasLocation] = useState(false);

  useEffect(() => {
    let alive = true;
    // The shared helper owns the 6s timeout and resolves null on any failure,
    // so this consumer only has to stop listening when unmounted (or when
    // propertyId changes and this run's closure goes stale). The deadline
    // below is a second, independent cap - see HARD_DEADLINE_MS.
    const deadline = setTimeout(() => {
      if (alive) setLoading(false);
    }, HARD_DEADLINE_MS);
    fetchHomeAlerts(propertyId).then((d) => {
      if (!alive) return;
      clearTimeout(deadline);
      setWeather(d?.current ?? null);
      setHasLocation(d?.hasLocation ?? false);
      setLoading(false);
      // A different home means a different forecast; collapse rather than
      // leave the previous home's week on screen mid-swap.
      setOpen(false);
    });
    return () => {
      alive = false;
      clearTimeout(deadline);
    };
  }, [propertyId]);

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 shadow-card dark:border-white/10 dark:bg-stone-800"
        aria-hidden="true"
      >
        <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  if (!weather) {
    // Two different kinds of "no weather": a home with no resolvable
    // location (a fresh claim still missing city/state/zip, or a zip outside
    // the launch cities) gets nothing here, same as before - there is
    // nothing to say. A home that DOES have a location but whose lookup
    // failed (upstream hiccup, or the hard deadline above firing before the
    // fetch settled) gets one quiet word instead of silently looking broken.
    if (hasLocation) {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm text-stone-500 shadow-card dark:border-white/10 dark:bg-stone-800 dark:text-stone-400">
          Weather unavailable
        </div>
      );
    }
    return null;
  }

  const { key, word } = conditionFor(weather.code, weather.isDay);
  const Icon = ICONS[key];
  const daily = weather.daily ?? [];
  // Nothing to expand into means no button and no chevron: a control that
  // opens an empty drawer is worse than a plain row.
  const expandable = daily.length > 0;

  const summary = (
    <>
      <Icon
        className="h-4 w-4 shrink-0 text-bark-700 dark:text-stone-300"
        aria-hidden="true"
      />
      {/* shrink-0 + nowrap: on a 390px phone the city is the only part allowed
          to give ground, so the temperature and high/low never wrap onto a
          second line to make room for it or for the chevron. */}
      <span className="shrink-0 whitespace-nowrap font-medium text-stone-900 dark:text-stone-100">
        {weather.tempF}&deg; {word}
      </span>
      <span className="shrink-0 whitespace-nowrap text-stone-500 dark:text-stone-400">
        H {weather.highF}&deg; L {weather.lowF}&deg;
      </span>
      {weather.city && (
        <span className="ml-auto min-w-0 truncate text-stone-500 dark:text-stone-400">
          {weather.city}
        </span>
      )}
    </>
  );

  return (
    <div className="rounded-xl border border-stone-200 bg-white text-sm shadow-card dark:border-white/10 dark:bg-stone-800">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide this week's forecast" : "Show this week's forecast"}
          className="flex w-full items-center gap-2 rounded-xl px-4 py-2.5 text-left"
        >
          {summary}
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-stone-400 transition-transform dark:text-stone-500 ${
              weather.city ? "" : "ml-auto"
            } ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2.5">{summary}</div>
      )}

      {expandable && open && (
        <ul className="divide-y divide-stone-100 border-t border-stone-200 px-4 dark:divide-white/5 dark:border-white/10">
          {daily.map((d, i) => {
            // Daily rows carry no day/night, so they always read as daytime.
            // A row with no code at all keeps its place in the list (rows are
            // labelled by date now, and a hole must not renumber the ones
            // after it) and simply shows no condition.
            const c = d.code === null ? null : conditionFor(d.code, true);
            const DayIcon = c ? ICONS[c.key] : null;
            return (
              <li key={`${d.date}-${i}`} className="flex items-center gap-2 py-2">
                <span className="w-16 shrink-0 text-stone-500 dark:text-stone-400">
                  {dayLabel(d.date, weather.today)}
                </span>
                {DayIcon ? (
                  <DayIcon
                    className="h-4 w-4 shrink-0 text-bark-700 dark:text-stone-300"
                    aria-hidden="true"
                  />
                ) : (
                  <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate text-stone-600 dark:text-stone-300">
                  {c ? c.word : "--"}
                </span>
                {d.rainPct !== null && d.rainPct >= RAIN_FLOOR && (
                  <span className="flex shrink-0 items-center gap-1 text-stone-500 dark:text-stone-400">
                    <Droplets className="h-3.5 w-3.5" aria-hidden="true" />
                    {d.rainPct}%
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-stone-900 dark:text-stone-100">
                  {d.highF === null ? "--" : `${d.highF}°`}{" "}
                  <span className="text-stone-500 dark:text-stone-400">
                    {d.lowF === null ? "--" : `${d.lowF}°`}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
