import Link from "next/link";
import { Lock } from "lucide-react";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import { stateName } from "@/lib/forecast";
import {
  estimateValueTimeline,
  anchorTimelineTo,
  calculateEquity,
  headlineHomeValue,
} from "@/lib/homeValue";
import {
  BUILDING_RECORD_NOTICE,
  plausibleHomeFigure,
} from "@/lib/parcelSanity";
import ValueForm from "./ValueForm";
import ValueAutoFetch from "./ValueAutoFetch";
import RefreshValue from "./RefreshValue";

// Same honest mask the /forecast page uses for its per-system amounts: real
// rows, real years, a masked amount. Never blurred fake numbers, and never a
// number that could read as a bug.
const MASKED_AMOUNT = "$•,•••";

// How many years of the trend a free account sees listed (masked) before the
// list is summarised. Enough to make the shape of what Plus opens obvious on a
// phone without turning a 20-year purchase into a wall of locks.
const MASKED_TREND_ROWS = 6;

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString()}`;
}

// Short form for the AVM range under the headline ($1.1M, $940k). The full
// form is two 7-digit numbers plus a dash, which is what makes that line wrap
// or overflow on a 390px phone; this keeps it on one line at any value.
function moneyCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    return `${sign}$${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (abs >= 1000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

// Compact form for the bar chart labels ($1.2k instead of $1,200), matching
// the /forecast page's moneyShort helper.
function moneyShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) {
    const k = abs / 1000;
    return `${n < 0 ? "-" : ""}$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `${n < 0 ? "-" : ""}$${Math.round(abs)}`;
}

export default async function ValuePage() {
  // WHAT PLUS BUYS ON THIS PAGE. The headline value, the confidence range,
  // what they paid, how much it has gained and their equity are FREE and stay
  // free: that is the whole truth about the home, and masking it would be
  // hiding the answer rather than the detail. Plus opens the year-by-year
  // trend behind it, and the refresh button that can pull a new reading.
  // Same shape as /forecast, which shows everyone the real 10-year total and
  // masks the per-system lines.
  //
  // The two reads don't depend on each other, so they run together rather
  // than stacking round trips (same pattern as /forecast).
  const [propertyOrNull, plus] = await Promise.all([
    getActiveProperty(),
    hasPlus(),
  ]);
  const property = propertyOrNull!;

  // purchase_price, mortgage_balance, and market_value/_low/_high are new
  // columns (migrations 0029 and 0066) that are not yet in
  // src/lib/database.types.ts, so they are read off the row with a cast
  // rather than widening the generated types by hand. If the relevant
  // migration has not run yet in this database, these just come back
  // undefined and the page degrades exactly like "not set yet".
  const raw = property as any;
  const storedPurchasePrice: number | null =
    typeof raw.purchase_price === "number" ? raw.purchase_price : null;
  const mortgageBalance: number | null =
    typeof raw.mortgage_balance === "number" ? raw.mortgage_balance : null;
  const marketValue: number | null =
    typeof raw.market_value === "number" ? raw.market_value : null;
  const marketValueLow: number | null =
    typeof raw.market_value_low === "number" ? raw.market_value_low : null;
  const marketValueHigh: number | null =
    typeof raw.market_value_high === "number" ? raw.market_value_high : null;

  // THE BUILDING-RECORD GATE (src/lib/parcelSanity.ts). A condo's county
  // record is the whole building's, so its last recorded sale can be the
  // developer buying the parcel: a tester in a mixed-use building read
  // "Bought for $34,000,000 in 2017, down $33,201,000 since" under a $799,000
  // estimate. The AVM is the estimate the gate measures against, never the
  // purchase price itself, so a bad price can never raise its own ceiling.
  const purchasePrice = plausibleHomeFigure(storedPurchasePrice, {
    unit: raw.unit,
    propertyType: raw.property_type,
    sqft: typeof raw.sqft === "number" ? raw.sqft : null,
    estimate: marketValue,
  });
  // A stored figure that the gate refused. Drives the one honest line below,
  // in place of the number: staying silent would read as "we have nothing",
  // which is not what happened.
  const purchasePriceHidden = storedPurchasePrice != null && purchasePrice == null;

  // purchase_date already exists on properties (since migration 0001); only
  // the year matters here, so it is stored as YYYY-01-01 and parsed back out.
  // Ignored along with the price when the gate refused it: a purchase year
  // with no purchase price is the building's sale date, not this home's.
  const purchaseYear: number | null =
    property.purchase_date && !purchasePriceHidden
      ? Number(property.purchase_date.slice(0, 4)) || null
      : null;

  const currentYear = new Date().getFullYear();
  const hasPurchaseData = purchasePrice != null && purchaseYear != null;
  const region = stateName(property.state);

  // One shared chooser (src/lib/homeValue.ts) picks the headline: the stored
  // RentCast AVM when we have one (real comparable sales for this address),
  // otherwise the capped purchase-price model. The dashboard tile calls the
  // same helper, so the two can never disagree on the same day.
  const headline = headlineHomeValue({
    marketValue,
    marketValueLow,
    marketValueHigh,
    purchasePrice,
    purchaseYear,
    state: property.state,
    currentYear,
  });
  const usingMarketValue = headline?.source === "avm";
  const estimatedValue = headline?.value ?? null;

  const appreciationGained =
    hasPurchaseData && estimatedValue != null ? estimatedValue - purchasePrice! : null;
  const equity =
    estimatedValue != null ? calculateEquity(estimatedValue, mortgageBalance) : null;
  // The timeline chart models the purchase-price trend year by year; it only
  // makes sense once we have a purchase price and year to start from.
  //
  // When the headline is the AVM, the raw model would put a $2.1M current-year
  // bar directly under an $890k headline on the same screen. So the whole
  // curve is rescaled to land on the headline (anchorTimelineTo), and the
  // chart says so in its title: it is the shape of the trend, anchored to the
  // estimate, not a second competing set of values.
  const modeledTimeline = hasPurchaseData
    ? estimateValueTimeline(purchasePrice!, purchaseYear!, property.state, currentYear)
    : [];
  const timeline =
    usingMarketValue && estimatedValue != null
      ? anchorTimelineTo(modeledTimeline, estimatedValue)
      : modeledTimeline;
  // Tallest bar in the chart, computed once rather than per bar.
  const timelineMax = Math.max(...timeline.map((x) => x.value), 1);

  // Trigger the lazy AVM fetch only when there's nothing on file yet and we
  // have an address to look up. The component itself does the fetch + router
  // refresh client-side, off this render.
  const needsFetch =
    marketValue == null && !!property.address_line1 && !!property.zip;

  // A refresh re-runs the AVM for this address, so it is only offered when
  // there is an address to run it on. Selling Plus off a button that could not
  // work for anyone would be the wrong kind of door.
  const canRefresh = !!property.address_line1 && !!property.zip;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <ValueAutoFetch needsFetch={needsFetch} propertyId={property.id} />
      <header className="mb-1">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Home value &amp; equity
        </h1>
      </header>
      <p className="mb-5 text-sm text-stone-500 dark:text-stone-400">
        A running estimate of what your home is worth today and how much of
        it you actually own, based on{" "}
        {usingMarketValue
          ? "recent sales data near you"
          : "statewide price trends since you bought it"}
        .
      </p>

      {!hasPurchaseData && !usingMarketValue && (
        <div className="space-y-4">
          <div className="card space-y-2 text-center">
            {/* The building-record case first: this owner has a county sale
                price on file, it is just not theirs, and telling them we
                "just need" a number without saying why would leave them
                wondering where the one they saw went. */}
            {purchasePriceHidden && (
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {BUILDING_RECORD_NOTICE}
              </p>
            )}
            <p className="text-sm text-stone-600 dark:text-stone-300">
              We just need what you paid and the year you bought your home.
              From there we track your home&apos;s estimated value and your
              equity automatically, no appraisal needed.
            </p>
          </div>
          <ValueForm
            purchasePrice={purchasePrice}
            purchaseYear={purchaseYear}
            mortgageBalance={mortgageBalance}
            currentYear={currentYear}
            startOpen
          />
        </div>
      )}

      {estimatedValue != null && (
        <>
          <div className="card-hero space-y-2 text-center">
            <p className="stat-label">Estimated value today</p>
            <p className="stat-number text-4xl text-bark-700 dark:text-stone-300">
              {money(estimatedValue)}{" "}
              <span className="align-middle rounded-full border border-bark-100 bg-bark-50 px-2 py-0.5 text-xs font-medium text-bark-700 dark:border-bark-700/40 dark:bg-bark-700/30 dark:text-stone-300">
                Estimate
              </span>
            </p>
            {/* RentCast's own confidence range, when it gave one. Compact
                form so "$1.1M - $1.4M" stays on one line on a phone. */}
            {headline?.low != null && headline.high != null && (
              <p className="text-xs tabular-nums text-bark-600 dark:text-stone-400">
                Likely between {moneyCompact(headline.low)} and{" "}
                {moneyCompact(headline.high)}
              </p>
            )}
            {hasPurchaseData ? (
              <p className="text-xs text-bark-700 dark:text-stone-300">
                Bought for {money(purchasePrice!)} in {purchaseYear}
                {appreciationGained != null && appreciationGained !== 0 && (
                  <>
                    {" "}
                    &middot;{" "}
                    <span
                      className={
                        appreciationGained > 0
                          ? "font-medium text-green-700 dark:text-green-400"
                          : "font-medium text-red-600 dark:text-red-400"
                      }
                    >
                      {appreciationGained > 0 ? "▲ up" : "▼ down"}{" "}
                      {money(appreciationGained)} since then
                    </span>
                  </>
                )}
              </p>
            ) : purchasePriceHidden ? (
              /* The county DID hand back a sale price - it just belongs to the
                 whole building, not this unit. Say that plainly where the
                 number would have been, rather than showing it or pretending
                 there was nothing on file. */
              <p className="text-xs text-bark-700 dark:text-stone-300">
                {BUILDING_RECORD_NOTICE}
              </p>
            ) : (
              <p className="text-xs text-bark-700 dark:text-stone-300">
                Add what you paid and the year you bought, and you&apos;ll
                also see your appreciation over time and a full value
                timeline.
              </p>
            )}
            {/* What the number is based on, said plainly. The provider's name
                (headline.sourceLabel) is deliberately NOT printed here or on
                the dashboard tile - it means nothing to a homeowner and read
                as clutter. The caveat is the part that actually matters. */}
            <p className="text-xs text-bark-600 dark:text-stone-400">
              {usingMarketValue
                ? "Based on recent comparable sales near you, not a full appraisal."
                : region
                ? `Ballpark based on statewide ${region} price trends, not your neighborhood.`
                : "Ballpark based on statewide price trends, not your neighborhood."}
            </p>
            {/* The Plus line, stated BEFORE the button, so a free account
                reads where the line is instead of tapping into it. The
                estimate behind this can only really move about once a month
                (the lookup is cached 30 days), which is what "monthly" means
                here - not a claim that anything runs on its own. */}
            {!plus && canRefresh && (
              <p className="text-xs text-bark-600 dark:text-stone-400">
                Your first estimate is free. Plus refreshes it monthly with new
                sales near you.
              </p>
            )}
            {canRefresh && (
              <div className="flex justify-center pt-1">
                <RefreshValue isPlus={plus} />
              </div>
            )}
          </div>

          <div className="card mt-6 space-y-2 text-center">
            <p className="stat-label">Home equity</p>
            <p
              className={`stat-number text-2xl ${
                equity != null && equity < 0 ? "text-red-600 dark:text-red-400" : ""
              }`}
            >
              {equity != null ? money(equity) : "-"}
            </p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {equity != null && equity < 0
                ? "Your mortgage balance is higher than your estimated value right now. This can happen with a recent purchase or a slow local market, and it usually corrects as you pay down the loan and prices rise."
                : mortgageBalance
                ? `Estimated value minus your ${money(mortgageBalance)} mortgage balance.`
                : "We're showing your full home value as equity because you haven't added a mortgage yet. Add your loan balance for a real number."}
            </p>
          </div>

          {!hasPurchaseData && (
            <div className="card mt-6 space-y-2 text-center">
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Add what you paid and the year you bought your home to also
                see your appreciation over time and a full value timeline.
              </p>
            </div>
          )}

          {hasPurchaseData && timeline.length > 1 && plus && (
            <div className="card mt-6 space-y-3">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                {usingMarketValue
                  ? "Value trend over time"
                  : "Estimated value over time"}
              </h2>
              <div className="overflow-x-auto pb-1">
                <div className="flex items-end gap-2 border-b border-stone-200 dark:border-white/10">
                  {timeline.map((p, i) => {
                    const height = Math.max(
                      6,
                      Math.round((p.value / timelineMax) * 96)
                    );
                    return (
                      <div
                        key={p.year}
                        title={`${p.year}: ${money(p.value)}`}
                        className="flex min-w-[2.75rem] flex-col items-center justify-end gap-1 transition hover:opacity-90"
                      >
                        <span className="text-[10px] font-medium tabular-nums text-stone-500 dark:text-stone-400">
                          {timeline.length > 10 && i % 2 !== 0
                            ? ""
                            : moneyShort(p.value)}
                        </span>
                        <div
                          className={`w-7 rounded-t-md ${
                            p.year === currentYear
                              ? "bg-bark-600 dark:bg-bark-600"
                              : "bg-bark-500 dark:bg-bark-600/60"
                          }`}
                          style={{ height: `${height}px` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  {timeline.map((p) => (
                    <span
                      key={p.year}
                      className="min-w-[2.75rem] text-center text-[10px] text-stone-500 dark:text-stone-400"
                    >
                      {p.year}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* The free version of the same section: real years, in the real
              order, with the amounts masked rather than faked - the pattern
              /forecast already uses for its per-system costs. The value and
              the equity above stay honest and unmasked; what Plus opens is
              the history behind them, year by year. */}
          {hasPurchaseData && timeline.length > 1 && !plus && (
            <div className="card mt-6 space-y-3">
              <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
                {usingMarketValue
                  ? "Value trend over time"
                  : "Estimated value over time"}
              </h2>
              <div className="divide-y divide-stone-100 dark:divide-white/10">
                {timeline
                  .slice(-MASKED_TREND_ROWS)
                  .reverse()
                  .map((p) => (
                    <div
                      key={p.year}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                        {p.year}
                      </p>
                      {/* This year's figure is the headline number printed in
                          a big font two cards up. Masking it here would be
                          theatre, not a limit, so it stays real and only the
                          history behind it is what Plus opens. */}
                      {p.year === currentYear ? (
                        <p className="whitespace-nowrap text-sm tabular-nums text-stone-600 dark:text-stone-300">
                          {money(p.value)}
                        </p>
                      ) : (
                        <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-stone-500 dark:text-stone-500">
                          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="tabular-nums">{MASKED_AMOUNT}</span>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
              {timeline.length > MASKED_TREND_ROWS && (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Plus goes back to {timeline[0].year}, the year you bought it.
                </p>
              )}
              <div className="rounded-lg border border-bark-100 bg-bark-50 p-4 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
                <p className="text-sm text-bark-700 dark:text-stone-300">
                  The value and equity above are your real numbers. Hearth Plus
                  opens the year-by-year trend behind them, so you can see how
                  your equity has built up, and keeps the estimate current with
                  a monthly refresh.
                </p>
                <Link
                  href="/plus?reason=value"
                  className="btn-primary mt-3 inline-block"
                >
                  See what Plus shows
                </Link>
              </div>
            </div>
          )}

          <div className="mt-6">
            <ValueForm
              purchasePrice={purchasePrice}
              purchaseYear={purchaseYear}
              mortgageBalance={mortgageBalance}
              currentYear={currentYear}
              startOpen={false}
            />
          </div>

          <p className="mt-6 text-xs text-stone-500 dark:text-stone-400">
            {usingMarketValue
              ? "This is an automated estimate based on recent comparable sales, not an appraisal. Your home's real value depends on its condition, upgrades, and what is actually selling nearby right now. For a number you can rely on to sell, refinance, or dispute taxes, talk to a local real estate agent or licensed appraiser."
              : "This is an estimate based on statewide average price trends, not an appraisal. Your home's real value depends on its condition, upgrades, and what is actually selling nearby right now. For a number you can rely on to sell, refinance, or dispute taxes, talk to a local real estate agent or licensed appraiser."}
          </p>
        </>
      )}
    </div>
  );
}
