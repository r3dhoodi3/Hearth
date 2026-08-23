import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import { buildForecast, stateName } from "@/lib/forecast";
import {
  estimateSeasonalEnergyCost,
  estimateUpgradeSavings,
} from "@/lib/energy";
import {
  labelFor,
  SYSTEM_TYPES,
  categoryForSystem,
  seasonForMonth,
} from "@/lib/constants";
import AskHearthPlanButton from "./AskHearthPlanButton";
import { Lock } from "lucide-react";

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

// Free users see the real 10-year total and their soonest system or two; the
// rest of the per-system amounts are masked (not blurred fake data) so the
// number stays honest while the detail is what Plus unlocks.
const MASKED_AMOUNT = "$•,•••";

// Compact form for the bar chart labels ($1.2k instead of $1,200) so a decade
// of bars stays readable on a phone screen.
function moneyShort(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `$${Math.round(n)}`;
}

export default async function ForecastPage() {
  // hasPlus and getActiveProperty don't depend on each other - run them
  // together instead of stacking two round trips before the redirect check.
  const [plus, propertyOrNull] = await Promise.all([
    hasPlus(),
    getActiveProperty(),
  ]);
  // Everyone reaches the forecast now: Plus sees it all, free users get the
  // real 10-year total plus a peek at the soonest systems, with the rest of
  // the per-system detail masked behind an honest Plus CTA (see below).
  if (!propertyOrNull) redirect("/onboarding");

  const property = propertyOrNull;
  const supabase = await createClient();

  // Same "open issues" query the Home page runs, so a resolved issue drops
  // out here on the very next load too - no separate flag to keep in sync.
  const [{ data: systems }, { data: issues }] = await Promise.all([
    // home_systems: kept as select(*) on purpose - see the matching comment
    // in dashboard/page.tsx. filter_size/filter_interval_months (migration
    // 0042) aren't in the generated Database type, so Supabase's typed client
    // rejects an explicit select string naming them (compile error), and
    // every other column here is genuinely read downstream, so trimming
    // would save zero bytes anyway.
    supabase
      .from("home_systems")
      .select("*")
      .eq("property_id", property.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("issues")
      // buildForecast's openIssues param is OpenIssueLite (Pick<Issue, "id" |
      // "system_id" | "category" | "severity" | "description">) - exactly
      // this column list, so no cast needed on the call below.
      .select("id, system_id, category, severity, description")
      .eq("property_id", property.id)
      .eq("status", "open")
      .order("created_at", { ascending: false }),
  ]);

  const sys = systems ?? [];
  const openIssues = issues ?? [];
  const nowDate = new Date(Date.now());
  const currentYear = nowDate.getFullYear();
  const forecast =
    sys.length > 0
      ? buildForecast(sys, currentYear, property.state, 10, openIssues)
      : null;
  const region = stateName(property.state);

  // Running-costs section: the season the owner is heading into (fall points
  // at winter, spring at summer), estimated from data already on this page.
  // Requires the state (same gate as the dashboard card): the fine print
  // claims state-specific weather and prices, so national-average numbers
  // must never pose as personal. May also come back null for seasons with a
  // negligible load (see estimateSeasonalEnergyCost), which hides the section.
  const calendarSeason = seasonForMonth(nowDate.getMonth());
  const energySeason: "winter" | "summer" =
    calendarSeason === "winter" || calendarSeason === "fall" ? "winter" : "summer";
  const hvacSystem = sys.find((s) => s.system_type === "hvac") ?? null;
  const energyEstimate =
    property.state != null
      ? estimateSeasonalEnergyCost({
          sqft: property.sqft,
          yearBuilt: property.year_built,
          state: property.state,
          hvacInstallYear: hvacSystem?.install_year ?? null,
          hvacType: hvacSystem?.material_or_model ?? null,
          season: energySeason,
          currentYear,
        })
      : null;
  // Non-null only when the HVAC has an install year and is 15+ years old.
  const upgradeSavings = hvacSystem
    ? estimateUpgradeSavings({
        sqft: property.sqft,
        yearBuilt: property.year_built,
        state: property.state,
        hvacInstallYear: hvacSystem.install_year,
        hvacType: hvacSystem.material_or_model,
        currentYear,
      })
    : null;

  // Personalize the handoff into Ask Hearth with the owner's actual top
  // priorities, not a generic prompt, so the answer is about their home.
  const planQuestion =
    forecast && forecast.startHere.length > 0
      ? `Help me plan for these upcoming home costs: ${forecast.startHere
          .map((p) => labelFor(SYSTEM_TYPES, p.item.system_type))
          .join(", ")}. Which should I tackle first?`
      : "Help me plan for my upcoming home costs. Which should I tackle first?";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-1">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Cost forecast
        </h1>
      </header>
      <p className="mb-5 text-sm text-stone-500 dark:text-stone-400">
        Most homeowners get surprised by a big repair sooner or later, and a
        five-figure one hurts. Here is what your home&apos;s systems are likely to
        need over the next {forecast?.horizonYears ?? 10} years, and how much
        to set aside so it never catches you off guard.
      </p>

      {!forecast && (
        <div className="card space-y-3 text-center">
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Add your home&apos;s systems to see a cost forecast and a recommended
            monthly set-aside amount.
          </p>
          {/* /dashboard#systems, not /profile: Home Profile was merged into
              the Home page. /profile still resolves here via the redirect in
              next.config.mjs, but an in-app link should not spend a round
              trip rediscovering that. */}
          <Link href="/dashboard#systems" className="btn-primary inline-block">
            Add my systems
          </Link>
        </div>
      )}

      {forecast && (
        <>
          <div className="card-hero space-y-2 text-center">
            <p className="text-sm text-bark-700 dark:text-stone-300">
              Over the next {forecast.horizonYears} years, plan for about{" "}
              <span className="font-semibold">
                {money(forecast.totalMidCost)}
              </span>
            </p>
            <p className="stat-number text-4xl text-bark-700 dark:text-stone-300">
              Set aside about {money(forecast.monthlySetAside)}/month
            </p>
            <p className="text-xs text-bark-700 dark:text-stone-300">
              So a big repair is a plan, not a panic.
            </p>
            <p className="text-xs text-bark-600 dark:text-stone-400">
              Ballpark from{" "}
              {region
                ? `statewide ${region} price trends`
                : "statewide price trends"}
              , adjusted for future prices, not just today&apos;s.
            </p>
            {forecast.estimatedTimingCount > 0 && (
              <p className="text-xs text-bark-600 dark:text-stone-400">
                {forecast.estimatedTimingCount === 1
                  ? "1 of your systems has no install year, so its timing here is a rough placement."
                  : `${forecast.estimatedTimingCount} of your systems have no install year, so their timing here is a rough placement.`}{" "}
                Add install years on your{" "}
                <Link
                  href="/dashboard#systems"
                  className="underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                >
                  home profile
                </Link>{" "}
                for a sharper forecast.
              </p>
            )}
          </div>

          {plus && (
          <>
          <div className="mt-4 flex justify-center">
            <AskHearthPlanButton question={planQuestion} />
          </div>

          {forecast.startHere.length > 0 && (
            <div className="card mt-6 space-y-3">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                Start here
              </h2>
              <div className="space-y-2">
                {forecast.startHere.map(({ item, reason }) => (
                  <div
                    key={item.system.id}
                    className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${
                      item.yearsLeft <= 1
                        ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                        : "border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-stone-700"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(SYSTEM_TYPES, item.system_type)}
                        </p>
                        <p className="text-xs text-stone-500 dark:text-stone-400">{reason}</p>
                      </div>
                    </div>
                    <Link
                      href={`/contractors?category=${categoryForSystem(item.system_type)}`}
                      className="btn-secondary shrink-0 whitespace-nowrap px-3 py-1.5 text-xs"
                    >
                      Get quotes
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card mt-6 space-y-3">
            <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
              Expected spend by year
            </h2>
            <div className="overflow-x-auto pb-1">
              <div className="flex items-end gap-2 border-b border-stone-200 dark:border-stone-700">
                {forecast.yearlySpend.map((y) => {
                  const max = Math.max(...forecast.yearlySpend.map((x) => x.amount), 1);
                  const height =
                    y.amount > 0 ? Math.max(6, Math.round((y.amount / max) * 96)) : 3;
                  return (
                    <div
                      key={y.year}
                      title={`${y.year}: ${money(y.amount)}`}
                      className="flex min-w-[2.5rem] flex-col items-center justify-end gap-1 transition hover:opacity-90"
                    >
                      <span className="text-[10px] font-medium tabular-nums text-stone-500 dark:text-stone-400">
                        {y.amount > 0 ? moneyShort(y.amount) : ""}
                      </span>
                      <div
                        className={`w-7 rounded-t-md ${
                          y.amount > 0
                            ? y.amount === max
                              ? "bg-bark-600 dark:bg-bark-600"
                              : "bg-bark-500 dark:bg-bark-600/60"
                            : "bg-stone-100 dark:bg-stone-700"
                        }`}
                        style={{ height: `${height}px` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2">
                {forecast.yearlySpend.map((y) => (
                  <span
                    key={y.year}
                    className="min-w-[2.5rem] text-center text-[10px] text-stone-500 dark:text-stone-400"
                  >
                    {y.year}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {energyEstimate && (
            <div className="card mt-6 space-y-3">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                Running costs, not just repairs
              </h2>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                Replacements are the big shocks, but your home also costs
                money to run every month.{" "}
                {energySeason === "winter"
                  ? "Keeping it warm this winter"
                  : "Keeping it cool this summer"}{" "}
                will likely run about{" "}
                <span className="font-semibold text-stone-900 dark:text-stone-100">
                  {money(energyEstimate.low)} - {money(energyEstimate.high)}
                </span>
                .
              </p>
              {upgradeSavings && (
                <div className="rounded-lg bg-bark-50 p-3 dark:bg-bark-700/30">
                  <p className="text-sm text-bark-700 dark:text-stone-300">
                    Your HVAC is about {upgradeSavings.hvacAge} years old, and
                    older units waste energy. A modern high-efficiency unit
                    could trim roughly{" "}
                    <span className="font-semibold">
                      {money(upgradeSavings.low)} -{" "}
                      {money(upgradeSavings.high)} a year
                    </span>{" "}
                    off your energy bills, on top of dodging a breakdown at
                    the worst possible time.
                  </p>
                  <Link
                    href={`/contractors?category=${categoryForSystem("hvac")}`}
                    className="mt-1 inline-block text-xs font-medium text-bark-700 hover:underline dark:text-stone-300"
                  >
                    Get replacement quotes →
                  </Link>
                </div>
              )}
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Ballpark from typical energy prices and 30-year weather
                averages for your state, give or take 30%. Your thermostat
                habits matter more than any formula.
              </p>
            </div>
          )}

          <div className="card mt-6 space-y-3">
            <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
              {forecast.horizonYears}-year timeline
            </h2>
            <div className="divide-y divide-stone-100 dark:divide-white/10">
              {forecast.timeline.map((item) => (
                <div
                  key={item.system.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                        {labelFor(SYSTEM_TYPES, item.system_type)}
                      </p>
                      <p className="text-xs text-stone-500 dark:text-stone-400">
                        {item.timingEstimated ? (
                          "Timing unknown, add an install year for a real estimate"
                        ) : (
                          <>
                            {item.yearsLeft <= 0
                              ? "Due now"
                              : `~${item.yearsLeft} year${item.yearsLeft === 1 ? "" : "s"} left`}
                            {" · "}
                            est. {item.replacementYear}
                          </>
                        )}
                      </p>
                      <Link
                        href={`/contractors?category=${categoryForSystem(item.system_type)}`}
                        className="text-xs font-medium text-bark-700 hover:underline dark:text-stone-300"
                      >
                        Get quotes →
                      </Link>
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-right text-sm text-stone-600 dark:text-stone-300">
                    <p>
                      {money(item.costLow)} - {money(item.costHigh)}
                    </p>
                    {!item.timingEstimated &&
                      item.replacementYear - currentYear > 1 && (
                        <p className="text-xs text-stone-500 dark:text-stone-400">
                          closer to ~{money(item.futureCost)} by{" "}
                          {item.replacementYear}
                        </p>
                      )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card mt-6 space-y-2">
            <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
              Why this matters
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Big-ticket systems like roofs and HVAC do not fail on a
              schedule, but they do fail eventually. Setting aside a little
              every month, instead of scrambling for a loan or a credit card
              when a system finally gives out, turns a five-figure surprise
              into a bill you already planned for.
            </p>
          </div>
          </>
          )}

          {!plus && (
            <div className="card mt-6 space-y-3">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                {forecast.horizonYears}-year timeline
              </h2>
              <div className="divide-y divide-stone-100 dark:divide-white/10">
                {/* The soonest system or two are shown in full: a real taste,
                    not a teaser on fake data. */}
                {forecast.timeline.slice(0, 2).map((item) => (
                  <div
                    key={item.system.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(SYSTEM_TYPES, item.system_type)}
                        </p>
                        <p className="text-xs text-stone-500 dark:text-stone-400">
                          {item.timingEstimated ? (
                            "Timing unknown, add an install year for a real estimate"
                          ) : (
                            <>
                              {item.yearsLeft <= 0
                                ? "Due now"
                                : `~${item.yearsLeft} year${item.yearsLeft === 1 ? "" : "s"} left`}
                              {" · "}
                              est. {item.replacementYear}
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="whitespace-nowrap text-right text-sm text-stone-600 dark:text-stone-300">
                      {money(item.costLow)} - {money(item.costHigh)}
                    </div>
                  </div>
                ))}

                {/* Everything past the peek: real system names, real order,
                    amounts masked rather than faked. */}
                {forecast.timeline.slice(2).map((item) => (
                  <div
                    key={item.system.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(SYSTEM_TYPES, item.system_type)}
                        </p>
                        <p className="text-xs text-stone-400 dark:text-stone-500">
                          Timing and cost with Plus
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 whitespace-nowrap text-right text-sm text-stone-400 dark:text-stone-500">
                      <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="tabular-nums">{MASKED_AMOUNT}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-bark-100 bg-bark-50 p-4 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
                <p className="text-sm text-bark-700 dark:text-stone-300">
                  That total up top is your real 10-year number.
                  {forecast.timeline.length > 2
                    ? " Hearth Plus opens up every system's timing and cost, the year-by-year chart of when the money is needed, and which projects to tackle first."
                    : " Hearth Plus adds the year-by-year chart of when the money is needed and which projects to tackle first."}
                </p>
                <Link href="/plus?reason=forecast" className="btn-primary mt-3 inline-block">
                  See what Plus shows
                </Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
