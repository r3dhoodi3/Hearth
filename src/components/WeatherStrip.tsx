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
import { formatLocalTime, timeZoneForProperty } from "@/lib/localTime";
import {
  conditionFor,
  dayLabel,
  type ConditionKey,
} from "@/lib/weatherLabels";
import {
  convertTemp,
  DEFAULT_TEMP_UNIT,
  formatTemp,
  readStoredTempUnit,
  storeTempUnit,
  type TempUnit,
} from "@/lib/weatherUnits";

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
// condition, today's high/low, city, and a "°F | °C" switch. Tapping the row
// expands the week ahead in place; the unit switch is a separate control at
// the end of the row (see unitToggle below) and converts every temperature
// here and in the expanded week. Always shown when data arrives (unlike HomeAlerts below it, which
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
  // Display unit for every temperature on the strip. Starts at the US default
  // rather than reading localStorage during render: this component is server
  // rendered, and a first paint that disagreed with the server's markup is a
  // hydration mismatch. The effect below swaps in the stored choice on the
  // client, before the weather fetch has realistically resolved, so a returning
  // Celsius user never sees a Fahrenheit number flash.
  const [unit, setUnit] = useState<TempUnit>(DEFAULT_TEMP_UNIT);

  useEffect(() => {
    setUnit(readStoredTempUnit());
  }, []);

  function chooseUnit(next: TempUnit) {
    setUnit(next);
    storeTempUnit(next);
  }

  useEffect(() => {
    let alive = true;
    // Reset first: this effect also reruns on a home switch (propertyId
    // changes without a remount, see the comment above this component), and
    // without clearing these first the previous home's weather/hasLocation
    // stay on screen - correct-looking but wrong - for as long as the new
    // fetch takes. Back to the same "loading" state a fresh mount starts in.
    setWeather(null);
    setHasLocation(false);
    setLoading(true);
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

  // The clock next to H/L. `now` starts null and stays null through the
  // first render on both server and client - reading Date.now() straight
  // into state would make the server's markup disagree with the client's on
  // the very first paint (a hydration mismatch), the same reason `unit`
  // above starts at a fixed default instead of reading localStorage during
  // render. The effect fires once on mount, fills in the real time, then
  // re-fills it aligned to each minute boundary: an immediate setTimeout to
  // the next :00, then a plain 60s interval from there - so the displayed
  // minute changes right when a real clock's would, not up to 59s late.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    function tick() {
      setNow(new Date());
    }
    tick();
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    const toNextMinute = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(toNextMinute);
      if (interval) clearInterval(interval);
    };
  }, []);

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

  // The route resolves this home's real IANA zone from Open-Meteo's own
  // `timezone=auto` response and passes it through as weather.timezone (see
  // CurrentWeather in src/lib/homeAlertsClient.ts). timeZoneForProperty
  // prefers that over a state guess, falling back to the launch area's own
  // zone when neither is available (a home with no location, or a lookup
  // that didn't return one).
  const zone = timeZoneForProperty({ tz: weather.timezone });
  const clockFull = now ? formatLocalTime(now, zone) : null;
  // Same clock, with the space before the meridiem dropped - used below sm
  // only, the same width budget that already hides the city there (see the
  // comment on the city span below). "3:42PM" buys back one character over
  // "3:42 PM" without losing any information.
  const clockCompact = clockFull ? clockFull.replace(/\s(?=[AP]M$)/, "") : null;

  const summary = (
    <>
      <Icon
        className="h-4 w-4 shrink-0 text-bark-700 dark:text-stone-300"
        aria-hidden="true"
      />
      {/* shrink-0 + nowrap: the city is the only part allowed to give ground
          (it truncates on desktop and drops out entirely on a phone - see
          below), so the temperature and high/low never wrap onto a second line
          to make room for it, the chevron, or the unit switch.
          Below sm there is no city left to give ground, and the worst case
          still does not fit: "108° Partly cloudy", "H 108° L 79°" and the
          clock come to about 300px inside a 318px row, before the chevron.
          So on a phone THIS is the one element allowed to shrink, and it
          truncates from the right - the number survives, the word (which the
          icon beside it already says) is what gets an ellipsis. Everything
          after it, the clock included, keeps its full width. */}
      <span className="shrink-0 whitespace-nowrap font-medium text-stone-900 max-sm:min-w-0 max-sm:shrink max-sm:truncate dark:text-stone-100">
        {convertTemp(weather.tempF, unit)}&deg; {word}
      </span>
      <span className="shrink-0 whitespace-nowrap text-stone-500 dark:text-stone-400">
        H {convertTemp(weather.highF, unit)}&deg; L{" "}
        {convertTemp(weather.lowF, unit)}&deg;
      </span>
      {/* The home's local time, same size/color as H/L so it reads as part
          of the same quiet group rather than a new piece of UI. Reserves its
          width (min-w) both before mount and while ticking, so filling in
          the real time - or the hour gaining/losing a digit at the top of
          the hour - never nudges the temperatures beside it. `now` is null
          until the effect above fires post-mount, so the placeholder is a
          plain non-breaking space rather than a real (server/client
          mismatched) time. */}
      <time
        dateTime={now ? now.toISOString() : undefined}
        aria-label="Local time at your home"
        // max-sm:min-w-[3.5rem]: the phone variant is "12:58PM", without the
        // separator dot or the space before the meridiem, so it reserves less
        // room. Same purpose at both widths - the reserved width never
        // depends on whether `now` has landed yet.
        className="inline-block min-w-[4.5rem] shrink-0 whitespace-nowrap tabular-nums text-stone-500 max-sm:min-w-[3.5rem] dark:text-stone-400"
      >
        {clockFull ? (
          <>
            <span className="hidden sm:inline">&middot; {clockFull}</span>
            {/* No separator dot below sm: at 390px the row is already over
                budget with the longest plausible values, and a decorative
                middle dot is the cheapest thing on it to lose. */}
            <span className="sm:hidden">{clockCompact}</span>
          </>
        ) : (
          " "
        )}
      </time>
      {/* Hidden below sm ONLY. At 390px the app shell leaves 342px of row,
          and the unit switch takes ~82 of it: keeping the city there would
          leave it about one character wide, which is an ellipsis pretending to
          be information. The header already shows this home's address (with
          its city) on every page, so on a phone the city here was the
          redundant part. sm and up are untouched - full city, ml-auto, same
          truncation as before. */}
      {weather.city && (
        <span className="ml-auto hidden min-w-0 truncate text-stone-500 sm:block dark:text-stone-400">
          {weather.city}
        </span>
      )}
    </>
  );

  // "°F | °C" pair sitting on the row itself, the way Google's weather card
  // does it - the one pattern of the three we looked at that needs no trip to
  // a settings screen on a phone. Two real buttons rather than one flipping
  // button, so tapping the unit you already have is a no-op instead of a
  // surprise. It lives OUTSIDE the expand button because a button inside a
  // button is invalid markup and would swallow the tap.
  //
  // h-10 / min-w-[2.5rem] keeps each half a 40px tap target; h-10 is also
  // exactly the height the py-2.5 row already was, so adding this changed no
  // vertical rhythm.
  //
  // WHERE it sits differs by width. On desktop it is on the row, as it always
  // was. On a phone it costs 94px (82 + its margin) of a 342px row, which is
  // what was pushing the clock underneath it - so on a phone it moves into the
  // week panel this row expands into, and the row gets those 94px back. A home
  // with no daily forecast has no panel to move it into, so there it stays on
  // the row at every width (`expandable` below).
  const unitToggle = (extra: string) => (
    <div
      role="group"
      aria-label="Temperature units"
      className={`flex shrink-0 overflow-hidden rounded-full border border-stone-200 dark:border-white/10 ${extra}`}
    >
      {(["F", "C"] as const).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => chooseUnit(u)}
          aria-pressed={unit === u}
          aria-label={
            u === "F"
              ? "Show temperatures in Fahrenheit"
              : "Show temperatures in Celsius"
          }
          // Phone only: 40x40 with a 12px glyph was below the touch floor and
          // hard to read. The phone home for this toggle has room for 44px.
          className={`flex h-10 min-w-[2.5rem] items-center justify-center px-2 text-xs font-medium max-sm:h-11 max-sm:min-w-11 max-sm:text-sm ${
            unit === u
              ? "bg-bark-700 text-white dark:bg-bark-600"
              : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          }`}
        >
          &deg;{u}
        </button>
      ))}
    </div>
  );

  return (
    <div className="rounded-xl border border-stone-200 bg-white text-sm shadow-card dark:border-white/10 dark:bg-stone-800">
      <div className="flex items-center">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Hide this week's forecast" : "Show this week's forecast"}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-2.5 pl-4 pr-2 text-left"
          >
            {summary}
            <ChevronDown
              // With the city hidden below sm there is nothing left to take
              // up the slack, so the chevron takes it there instead. A home
              // with no city at all keeps ml-auto at every width, as before.
              className={`h-4 w-4 shrink-0 text-stone-400 transition-transform dark:text-stone-500 ${
                weather.city ? "max-sm:ml-auto" : "ml-auto"
              } ${open ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-4 pr-2">
            {summary}
          </div>
        )}
        {/* Phone: hidden here and re-rendered inside the open week panel
            below, so the row keeps its full width for the temperatures and
            the clock. Unless there is no week to open, in which case this is
            the only place it can live. */}
        {unitToggle(expandable ? "mr-3 max-sm:hidden" : "mr-3")}
      </div>

      {expandable && open && (
        <>
        {/* The phone's home for the unit switch (see unitToggle above). Two
            real 40px targets, labelled, in the panel the row already opens -
            the only cost of getting it off a 342px row that could not hold
            it and the clock at the same time. */}
        <div className="flex items-center justify-between gap-3 border-t border-stone-200 px-4 py-2 sm:hidden dark:border-white/10">
          <span className="text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
            Units
          </span>
          {unitToggle("")}
        </div>
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
                  {formatTemp(d.highF, unit)}{" "}
                  <span className="text-stone-500 dark:text-stone-400">
                    {formatTemp(d.lowF, unit)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}
