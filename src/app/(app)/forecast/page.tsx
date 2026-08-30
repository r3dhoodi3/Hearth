import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import { buildForecast, stateName, type ForecastItem } from "@/lib/forecast";
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
import {
  forecastActionFor,
  topRiskItems,
  lifeUsedFraction,
  HIGH_CONSEQUENCE_SYSTEMS,
  EMERGENCY_PREMIUM_COPY,
  ACTIONS_AS_OF,
  type ForecastAction,
} from "@/lib/forecastActions";
import {
  incentivesForSystem,
  bestIncentiveAmount,
  hasLiveProgram,
  INCENTIVE_CAVEAT,
  INCENTIVES_AS_OF,
  type ForecastIncentive,
} from "@/lib/forecastIncentives";
import {
  reservePlan,
  reserveStatusCopy,
  dollarsFromCents,
  RESERVE_HORIZON_YEARS,
} from "@/lib/forecastReserve";
import { isMissingSchemaError } from "@/lib/dbErrors";
import AskHearthPlanButton from "./AskHearthPlanButton";
import QuoteEarlyLink from "./QuoteEarlyLink";
import IncentiveViewTracker from "./IncentiveViewTracker";
import { addForecastStepAction, saveRepairReserveAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import { Lock } from "lucide-react";
import Breadcrumbs from "@/components/Breadcrumbs";

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

// The "push it out" sentence, in the owner's own numbers: what the step costs,
// what it delays, and by how long. Always a RANGE and always the word
// "typically", because this is national ballpark data, not a quote, and a
// single number here would be exactly the fake precision the rest of this page
// is careful to avoid.
function pushItOutLine(action: ForecastAction, item: ForecastItem): string {
  const label = labelFor(SYSTEM_TYPES, item.system_type).toLowerCase();
  return `Typically ${money(action.costLow)} to ${money(
    action.costHigh
  )}, and it usually pushes a ${money(
    item.costMid
  )} ${label} replacement out ${action.yearsGainedLow}-${action.yearsGainedHigh} years.`;
}

// Why this system is one of the two the page tells you to go get quotes for.
// One plain sentence, because a ranking nobody can explain reads as a guess.
function riskReason(item: ForecastItem): string {
  const label = labelFor(SYSTEM_TYPES, item.system_type).toLowerCase();
  const consequence = HIGH_CONSEQUENCE_SYSTEMS.has(item.system_type);
  const used = Math.round(lifeUsedFraction(item) * 100);
  const age =
    item.age != null
      ? `Your ${label} is about ${item.age} years old against a typical ${item.lifespan} year life`
      : `Your ${label} is about ${used}% of the way through a typical ${item.lifespan} year life`;
  return consequence
    ? `${age}, and when this one goes it does damage while you wait.`
    : `${age}, so it is the one most likely to surprise you first.`;
}

// The post-a-job flow, prefilled. /contractors already reads category, desc and
// timing off the query string (see its searchParams block), so this needs no
// new plumbing: it just arrives at the form with the boxes filled in.
// "flexible" timing on purpose, because the whole point of this card is that
// nothing is broken yet.
function quoteHref(item: ForecastItem): string {
  const label = labelFor(SYSTEM_TYPES, item.system_type).toLowerCase();
  const when =
    item.timingEstimated || item.yearsLeft <= 0
      ? "is at the end of its typical life"
      : `looks likely to need replacing around ${item.replacementYear}`;
  const desc =
    `Planning ahead, nothing is broken. My ${label} ${when}, and I would rather ` +
    `get quotes now than at 2am when it fails. Happy to schedule this whenever suits you.`;
  return `/contractors?category=${categoryForSystem(
    item.system_type
  )}&timing=flexible&desc=${encodeURIComponent(desc)}`;
}

// One system's rebate lines. Rendered as a disclosure so a phone card is not
// four links tall by default, and so the caveat and the "as of" date travel
// with the amounts rather than sitting somewhere the reader will not scroll to.
function IncentiveLines({ incentives }: { incentives: ForecastIncentive[] }) {
  return (
    <>
      {incentives.map((inc) => {
        const amount = bestIncentiveAmount(inc);
        const live = hasLiveProgram(inc);
        const headline =
          amount != null
            ? `Up to ${money(amount)} back: ${inc.label}`
            : live
              ? `Rebates may apply: ${inc.label}`
              : `${inc.label}: the federal credit has ended`;
        return (
          <details key={inc.key} className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-bark-700 dark:text-stone-300 max-sm:flex max-sm:min-h-11 max-sm:items-center">
              {headline}
            </summary>
            <ul className="mt-1 space-y-1.5">
              {inc.programs.map((p) => (
                <li
                  key={p.name}
                  className="text-xs leading-relaxed text-stone-500 dark:text-stone-400"
                >
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-bark-700 underline dark:text-stone-300"
                  >
                    {p.name}
                  </a>
                  {p.status === "ended"
                    ? " (ended). "
                    : p.maxAmount != null
                      ? ` up to ${money(p.maxAmount)}. `
                      : ". "}
                  {p.note}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
              {INCENTIVE_CAVEAT} Table last checked {INCENTIVES_AS_OF}.
            </p>
          </details>
        );
      })}
    </>
  );
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

  // The repair reserve (migration 0147), read in its OWN small query rather
  // than through getActiveProperty's shared column list. Naming a column the
  // live database has not migrated yet makes Postgres reject the whole select
  // with 42703, and that shared list is used by every page in the app, so a
  // pending migration would put all of them on the retry path. Here the cost of
  // a missing column is one null and a read-only reserve card.
  let reserveCents: number | null = null;
  if (plus) {
    const { data: reserveRow, error: reserveError } = await (
      supabase.from("properties") as any
    )
      .select("repair_reserve_cents")
      .eq("id", property.id)
      .maybeSingle();
    if (!reserveError && reserveRow) {
      reserveCents = reserveRow.repair_reserve_cents ?? null;
    } else if (reserveError && !isMissingSchemaError(reserveError)) {
      // A real failure (not a pending migration) still must not break the
      // page: the forecast is useful without the reserve card's saved figure.
      console.error("forecast: reserve read failed:", reserveError.message);
    }
  }

  const sys = systems ?? [];
  const openIssues = issues ?? [];
  const nowDate = new Date(Date.now());
  const currentYear = nowDate.getFullYear();
  const forecast =
    sys.length > 0
      ? buildForecast(sys, currentYear, property.state, 10, openIssues)
      : null;
  const region = stateName(property.state);

  // The four "make the timeline actionable" pieces, all derived from the
  // forecast that is already built. Computed once here rather than inline in
  // the markup so the free and Plus branches below can both reach them.
  const riskItems = forecast ? topRiskItems(forecast.timeline) : [];
  const reserve = forecast
    ? reservePlan(forecast.timeline, currentYear, dollarsFromCents(reserveCents))
    : null;
  // How many rebate lines actually render, for the one analytics beacon.
  const incentiveCount = forecast
    ? forecast.timeline.reduce(
        (n, item) => n + incentivesForSystem(item.system_type).length,
        0
      )
    : 0;
  // The single worked example a free reader gets: their soonest system that has
  // a curated step. Real data about their own home, not a demo house.
  const freeExample = forecast
    ? (forecast.timeline
        .map((item) => ({ item, action: forecastActionFor(item.system_type) }))
        .find((x) => x.action != null) ?? null)
    : null;

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
      <Breadcrumbs items={[{ label: "Home", href: "/dashboard" }, { label: "Cost forecast" }]} />
      <header className="mb-1">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Cost forecast
        </h1>
      </header>
      <p className="mb-5 text-sm text-stone-500 dark:text-stone-400">
        Most homeowners get surprised by a big repair sooner or later, and a
        five-figure one hurts. Here is what your home&apos;s systems are likely to
        need over the next {forecast?.horizonYears ?? 10} years, how much
        to set aside so it never catches you off guard, and what you can do now
        to push each bill further out.
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

          {/* Reserve plan. Sits right under the headline set-aside because it
              answers the very next question that number provokes: am I
              actually going to have it. The five-year window is deliberate,
              see the comment at the top of src/lib/forecastReserve.ts. */}
          {reserve && (
            <div className="card mt-6 space-y-3">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                Your repair reserve
              </h2>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {reserve.nextBig
                  ? `Over the next ${RESERVE_HORIZON_YEARS} years your list adds up to about ${money(
                      reserve.nextFiveYearTotal
                    )}. That is ${money(
                      reserve.monthlySetAside
                    )} a month, and the biggest single item is your ${labelFor(
                      SYSTEM_TYPES,
                      reserve.nextBig.system_type
                    ).toLowerCase()} at about ${money(
                      reserve.nextBig.futureCost
                    )} in ${reserve.nextBig.replacementYear}.`
                  : `Nothing big lands in the next ${RESERVE_HORIZON_YEARS} years, so anything you put away now is a head start on the years after that.`}
              </p>

              {reserve.nextBig && (
                <div className="space-y-1">
                  <div
                    className="h-2 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-700"
                    role="progressbar"
                    aria-valuenow={reserve.progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Progress toward your next big repair"
                  >
                    <div
                      className="h-full rounded-full bg-bark-500 dark:bg-bark-600"
                      style={{ width: `${reserve.progressPct}%` }}
                    />
                  </div>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    {reserve.savedDollars != null
                      ? `${money(reserve.savedDollars)} of ${money(
                          reserve.nextBig.futureCost
                        )} set aside.`
                      : "Nothing entered yet."}
                  </p>
                </div>
              )}

              <p className="text-sm text-stone-600 dark:text-stone-300">
                {reserveStatusCopy(reserve)}
              </p>

              {/* Plain uncontrolled form: the value round-trips through the
                  server action and comes back on the next render, so there is
                  no client state to keep in sync. SubmitButton gives it the
                  pending state every action in this app has. */}
              <form
                action={saveRepairReserveAction}
                className="flex flex-wrap items-end gap-2"
              >
                <div className="min-w-[9rem] flex-1">
                  <label className="label" htmlFor="reserve">
                    What you have saved so far
                  </label>
                  <input
                    id="reserve"
                    name="reserve"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="4500"
                    defaultValue={
                      reserve.savedDollars != null
                        ? String(reserve.savedDollars)
                        : ""
                    }
                    className="input"
                  />
                </div>
                <SubmitButton
                  className="btn-secondary max-sm:min-h-11"
                  pendingLabel="Saving…"
                >
                  Save
                </SubmitButton>
              </form>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Only you and your household see this. Leave it blank to clear it.
              </p>
            </div>
          )}

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

          {/* "Quote it now, not at 2am". Two systems only: the point is a
              decision the owner can act on this week, and a list of six is a
              list nobody works through. */}
          {riskItems.length > 0 && (
            <div className="card mt-6 space-y-3" data-testid="quote-early-card">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                Line up quotes early
              </h2>
              <p className="text-sm text-stone-500 dark:text-stone-400">
                {EMERGENCY_PREMIUM_COPY} Getting two or three numbers now, while
                nothing is broken, is the cheapest hour you will spend on this
                house.
              </p>
              <div className="space-y-2">
                {riskItems.map((item) => (
                  <div
                    key={item.system.id}
                    className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-700"
                  >
                    <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                      {labelFor(SYSTEM_TYPES, item.system_type)}
                    </p>
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      {riskReason(item)}
                    </p>
                    <QuoteEarlyLink
                      href={quoteHref(item)}
                      systemType={item.system_type}
                      className="btn-secondary mt-2 inline-flex px-3 py-1.5 text-xs max-sm:min-h-11 max-sm:items-center"
                    >
                      Line up quotes
                    </QuoteEarlyLink>
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
                    Your heating and cooling (HVAC) is about {upgradeSavings.hvacAge} years old, and
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
            {/* Desktop keeps the divided list it has always had. On a phone the
                divider is dropped and each system becomes its own card, because
                a row that now carries a step, a rebate line and two buttons is
                no longer a row. */}
            <div className="divide-y divide-stone-100 dark:divide-white/10 max-sm:space-y-3 max-sm:divide-y-0">
              {forecast.timeline.map((item) => {
                const action = forecastActionFor(item.system_type);
                const incentives = incentivesForSystem(item.system_type);
                return (
                <div
                  key={item.system.id}
                  className="py-3 max-sm:rounded-xl max-sm:border max-sm:border-stone-200 max-sm:bg-white max-sm:p-3 dark:max-sm:border-white/10 dark:max-sm:bg-stone-800"
                >
                  <div className="flex items-center justify-between gap-3">
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

                  {/* Push it out: the one step that buys this system more time,
                      with what it costs and what it delays. */}
                  {action && (
                    <div className="mt-2 rounded-lg bg-stone-50 p-3 dark:bg-stone-700/40">
                      <p className="text-xs font-medium text-stone-900 dark:text-stone-100">
                        {action.step}
                      </p>
                      <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                        {pushItOutLine(action, item)}
                      </p>
                      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        {action.why}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <form action={addForecastStepAction}>
                          <input
                            type="hidden"
                            name="system_type"
                            value={item.system_type}
                          />
                          <SubmitButton
                            className="btn-secondary px-3 py-1.5 text-xs max-sm:min-h-11"
                            pendingLabel="Adding…"
                          >
                            Add to my plan
                          </SubmitButton>
                        </form>
                        <Link
                          href={`/contractors?category=${categoryForSystem(item.system_type)}`}
                          className="text-xs font-medium text-bark-700 hover:underline dark:text-stone-300 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                        >
                          Find a pro
                        </Link>
                      </div>
                    </div>
                  )}

                  {incentives.length > 0 && (
                    <IncentiveLines incentives={incentives} />
                  )}
                </div>
                );
              })}
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Maintenance steps and the years they buy are typical figures,
              last reviewed {ACTIONS_AS_OF}. Your house, your climate and your
              installer all move them.
            </p>
          </div>

          {incentiveCount > 0 && <IncentiveViewTracker count={incentiveCount} />}

          <div className="card mt-6 space-y-2">
            <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
              Why this matters
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Big systems like roofs and HVAC don&apos;t fail on a schedule,
              but they do fail eventually. Set aside a little every month, and
              a five-figure surprise becomes a bill you already planned for,
              instead of a loan or credit card scramble.
            </p>
          </div>
          </>
          )}

          {!plus && (
            <>
            {/* The shape of the paid feature, on ONE real system of theirs: the
                step, what it costs, what it delays. Same principle as the
                two-system timeline peek below - a real taste, never a demo
                house and never a blurred fake number. */}
            {freeExample?.action && (
              <div className="card mt-6 space-y-2" data-testid="free-push-example">
                <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Push it out
                </h2>
                <p className="text-sm text-stone-500 dark:text-stone-400">
                  Most of these bills can be delayed for a fraction of what they
                  cost. Here is the one for your{" "}
                  {labelFor(SYSTEM_TYPES, freeExample.item.system_type).toLowerCase()}.
                </p>
                <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-700/40">
                  <p className="text-xs font-medium text-stone-900 dark:text-stone-100">
                    {freeExample.action.step}
                  </p>
                  <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                    {pushItOutLine(freeExample.action, freeExample.item)}
                  </p>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    {freeExample.action.why}
                  </p>
                </div>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Typical figures, last reviewed {ACTIONS_AS_OF}. Plus adds one
                  of these for every system on your list, the rebates and
                  credits worth checking before each replacement, and a reserve
                  plan that tracks what you have actually saved.
                </p>
              </div>
            )}

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
                        <p className="text-xs text-stone-500 dark:text-stone-500">
                          Timing and cost with Plus
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 whitespace-nowrap text-right text-sm text-stone-500 dark:text-stone-500">
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
                    ? " Hearth Plus opens up every system's timing and cost, the step that pushes each one further out, the rebates worth checking, and a reserve plan that tracks what you have saved."
                    : " Hearth Plus adds the step that pushes each system further out, the rebates worth checking, a reserve plan that tracks what you have saved, and the year-by-year chart of when the money is needed."}
                </p>
                <Link href="/plus?reason=forecast" className="btn-primary mt-3 inline-block">
                  See what Plus shows
                </Link>
              </div>
            </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
