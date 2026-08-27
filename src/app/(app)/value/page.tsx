import { getActiveProperty } from "@/lib/property";
import { stateName } from "@/lib/forecast";
import {
  estimateValueTimeline,
  anchorTimelineTo,
  calculateEquity,
  headlineHomeValue,
} from "@/lib/homeValue";
import ValueForm from "./ValueForm";
import ValueAutoFetch from "./ValueAutoFetch";

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
  const property = (await getActiveProperty())!;

  // purchase_price, mortgage_balance, and market_value/_low/_high are new
  // columns (migrations 0029 and 0066) that are not yet in
  // src/lib/database.types.ts, so they are read off the row with a cast
  // rather than widening the generated types by hand. If the relevant
  // migration has not run yet in this database, these just come back
  // undefined and the page degrades exactly like "not set yet".
  const raw = property as any;
  const purchasePrice: number | null =
    typeof raw.purchase_price === "number" ? raw.purchase_price : null;
  const mortgageBalance: number | null =
    typeof raw.mortgage_balance === "number" ? raw.mortgage_balance : null;
  const marketValue: number | null =
    typeof raw.market_value === "number" ? raw.market_value : null;
  const marketValueLow: number | null =
    typeof raw.market_value_low === "number" ? raw.market_value_low : null;
  const marketValueHigh: number | null =
    typeof raw.market_value_high === "number" ? raw.market_value_high : null;

  // purchase_date already exists on properties (since migration 0001); only
  // the year matters here, so it is stored as YYYY-01-01 and parsed back out.
  const purchaseYear: number | null = property.purchase_date
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
            ) : (
              <p className="text-xs text-bark-700 dark:text-stone-300">
                Add what you paid to see how much you&apos;ve gained since you
                bought it.
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
                : "Estimated value, since no mortgage balance is on file."}
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

          {hasPurchaseData && timeline.length > 1 && (
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
