// Pure math for the free "Home Value & Equity" tracker. No DB access here:
// the page reads purchase_price, the purchase year (derived from
// properties.purchase_date), and mortgage_balance, and passes them in along
// with the current year (never call argless `new Date()`).
//
// The whole estimate rests on one simplification: home prices in a state rise
// at roughly the same clip every year. Real markets don't move that smoothly,
// but a single compounding rate is honest about what this feature is, a quick
// ballpark, not a substitute for an appraisal or a comparative market analysis
// from a real estate agent.

// Approximate recent average annual home-price appreciation by state, modeled
// on FHFA House Price Index trends (the federal index tracking repeat sales
// and refinances nationwide). These numbers are a static snapshot baked in at
// build time, not a live feed: they will drift out of date and do not capture
// city-to-city swings within a state. Good enough for "about how much has my
// home probably gone up," not for pricing a sale.
export const STATE_APPRECIATION_RATES: Record<string, number> = {
  AL: 0.06,
  AK: 0.04,
  AZ: 0.075,
  AR: 0.06,
  CA: 0.06,
  CO: 0.065,
  CT: 0.05,
  DE: 0.06,
  DC: 0.05,
  FL: 0.08,
  GA: 0.07,
  HI: 0.055,
  ID: 0.09,
  IL: 0.045,
  IN: 0.06,
  IA: 0.055,
  KS: 0.055,
  KY: 0.055,
  LA: 0.04,
  ME: 0.07,
  MD: 0.05,
  MA: 0.06,
  MI: 0.06,
  MN: 0.055,
  MS: 0.055,
  MO: 0.06,
  MT: 0.075,
  NE: 0.06,
  NV: 0.075,
  NH: 0.065,
  NJ: 0.055,
  NM: 0.065,
  NY: 0.045,
  NC: 0.07,
  ND: 0.04,
  OH: 0.06,
  OK: 0.055,
  OR: 0.065,
  PA: 0.055,
  RI: 0.065,
  SC: 0.07,
  SD: 0.06,
  TN: 0.075,
  TX: 0.065,
  UT: 0.08,
  VT: 0.06,
  VA: 0.06,
  WA: 0.07,
  WV: 0.045,
  WI: 0.055,
  WY: 0.05,
};

// Used whenever a property's state is missing or not one we have a rate for,
// so the estimate degrades to a reasonable national ballpark instead of
// disappearing. Clearly labeled so callers/readers know this is the fallback,
// not a real state's figure.
export const DEFAULT_APPRECIATION_RATE = 0.05;

// Annual appreciation rate for a state, defaulting to DEFAULT_APPRECIATION_RATE
// when the state is missing or unrecognized.
export function appreciationRateFor(state: string | null | undefined): number {
  if (!state) return DEFAULT_APPRECIATION_RATE;
  return STATE_APPRECIATION_RATES[state.toUpperCase()] ?? DEFAULT_APPRECIATION_RATE;
}

// Ceiling on the compounding fallback, as a multiple of what was actually
// paid. Compounding is only credible over a handful of years: at 6% a year a
// 2007 purchase is 3x by 2026, so a real $3.9M sale rendered as $11.8M in a
// big confident font on the dashboard. Nothing about that number came from
// this home. 2.5x is deliberately blunt - it is not a better model, it is a
// guardrail that keeps an old purchase from ballooning into a figure we would
// have to apologise for. Roughly 16 years of appreciation at the 6% median
// rate, past which the estimate stops moving and the honest answer is the
// RentCast AVM (see headlineHomeValue below), not more compounding.
export const FALLBACK_VALUE_CAP_MULTIPLE = 2.5;

// Compounds the state's annual rate from the purchase year to the current
// year to estimate today's value, capped at FALLBACK_VALUE_CAP_MULTIPLE times
// the purchase price. A purchase year in the future, or equal to the current
// year, is treated as zero elapsed years (returns purchasePrice unchanged)
// rather than producing a negative or inflated result.
export function estimateHomeValue(
  purchasePrice: number,
  purchaseYear: number,
  state: string | null | undefined,
  currentYear: number
): number {
  const rate = appreciationRateFor(state);
  const years = Math.max(0, currentYear - purchaseYear);
  const compounded = purchasePrice * Math.pow(1 + rate, years);
  return Math.round(
    Math.min(compounded, purchasePrice * FALLBACK_VALUE_CAP_MULTIPLE)
  );
}

// One estimated value per year from the purchase year through the current
// year, for a simple growth chart. Always at least one point (the purchase
// year itself), even if purchaseYear >= currentYear.
export interface ValuePoint {
  year: number;
  value: number;
}

export function estimateValueTimeline(
  purchasePrice: number,
  purchaseYear: number,
  state: string | null | undefined,
  currentYear: number
): ValuePoint[] {
  const lastYear = Math.max(purchaseYear, currentYear);
  const points: ValuePoint[] = [];
  for (let year = purchaseYear; year <= lastYear; year++) {
    points.push({ year, value: estimateHomeValue(purchasePrice, purchaseYear, state, year) });
  }
  return points;
}

// Home equity: what the estimated value minus what is still owed. A null or
// missing mortgage balance is treated as 0 (an owner who hasn't entered a
// balance, or has paid off the home), not as "unknown", so the math never
// breaks. This intentionally does NOT floor the result at 0: if the mortgage
// balance is higher than the estimated value, the homeowner is genuinely
// underwater, and hiding that behind a floor would be dishonest. The page is
// responsible for framing a negative number gently in the UI.
export function calculateEquity(
  estimatedValue: number,
  mortgageBalance: number | null | undefined
): number {
  const balance = mortgageBalance ?? 0;
  return estimatedValue - balance;
}

// ===========================================================================
// The headline number, in one place.
//
// The dashboard tile and the /value page were each picking their own value,
// their own year-over-year delta and their own caption, which is how they
// ended up able to disagree on the same day. Both now call this, so the number
// in the tile, the number on the page, and the equity math underneath are the
// same number by construction.
// ===========================================================================

export type HomeValueSource = "avm" | "formula";

export interface HeadlineHomeValue {
  // What to show, and what equity must be computed from.
  value: number;
  source: HomeValueSource;
  // The AVM's confidence range, only ever set when source is "avm" and
  // RentCast returned both ends.
  low: number | null;
  high: number | null;
  // How much the number moved, and over what. Null when there is nothing
  // honest to say - which is a real case, not a placeholder: an AVM for
  // someone who never entered a purchase price has no earlier figure from the
  // same source to compare against.
  //
  // "year"     - this year's modeled value minus last year's, both from the
  //              same capped model. Only ever set in fallback mode.
  // "purchase" - the AVM minus what they actually paid. A real difference
  //              between two real numbers, and the only comparison the AVM
  //              supports: the AVM is a point-in-time reading with no history
  //              behind it, so any "this year" figure for it would have to be
  //              modeled from the appreciation rate and dressed up as a
  //              measurement. This can be negative, and should be.
  change: number | null;
  changeSince: "year" | "purchase" | null;
  // Where the number came from, in plain words. NOT rendered anywhere in the
  // UI any more: the dashboard tile, /value and /taxes all dropped it because
  // naming the provider told a homeowner nothing and read as clutter. Kept on
  // the type because it is a useful, tested description of which branch
  // produced the value, and callers (logging, future admin views) may want it.
  sourceLabel: string;
}

export const AVM_SOURCE_LABEL = "Estimate from RentCast";
export const FORMULA_SOURCE_LABEL = "Estimate based on your purchase price";

export function headlineHomeValue(input: {
  // The stored RentCast AVM, when one has landed for this home.
  marketValue: number | null;
  marketValueLow: number | null;
  marketValueHigh: number | null;
  purchasePrice: number | null;
  purchaseYear: number | null;
  state: string | null | undefined;
  currentYear: number;
}): HeadlineHomeValue | null {
  const {
    marketValue,
    marketValueLow,
    marketValueHigh,
    purchasePrice,
    purchaseYear,
    state,
    currentYear,
  } = input;

  // The AVM wins whenever we have one: it is priced off actual comparable
  // sales for this address, where the fallback is a statewide average applied
  // to one old number.
  if (marketValue != null && marketValue > 0) {
    return {
      value: marketValue,
      source: "avm",
      low: marketValueLow != null && marketValueLow > 0 ? marketValueLow : null,
      high:
        marketValueHigh != null && marketValueHigh > 0 ? marketValueHigh : null,
      // Against the purchase price when we have one, and nothing at all when
      // we don't. See the `change` docs above for why there is no yearly
      // figure here.
      change: purchasePrice != null ? marketValue - purchasePrice : null,
      changeSince: purchasePrice != null ? "purchase" : null,
      sourceLabel: AVM_SOURCE_LABEL,
    };
  }

  if (purchasePrice == null || purchaseYear == null) return null;

  const value = estimateHomeValue(purchasePrice, purchaseYear, state, currentYear);
  const lastYear = estimateHomeValue(
    purchasePrice,
    purchaseYear,
    state,
    currentYear - 1
  );
  // Both years run through the same capped model, so a home already at the cap
  // reports a 0 change - which is the truth about this estimate, not a hidden
  // flat market.
  return {
    value,
    source: "formula",
    low: null,
    high: null,
    change: value - lastYear,
    changeSince: "year",
    sourceLabel: FORMULA_SOURCE_LABEL,
  };
}

// Rescales a modeled timeline so its last point lands exactly on `anchor`,
// keeping the shape of the curve but not its absolute numbers.
//
// The /value chart is built from the purchase-price model, so when the
// headline above comes from the AVM the two disagree on the same screen: a
// headline of $890k over a chart whose highlighted current-year bar reads
// $2.1M. Scaling every point by anchor/last makes the final bar equal the
// headline and every earlier bar the same fraction of it the model said it
// was. That is honest about what the chart is - the trend, anchored to the
// estimate - as long as the page labels it that way, which it does.
//
// A non-positive last point (nothing to scale from) returns the points
// untouched rather than dividing by zero.
export function anchorTimelineTo(
  points: ValuePoint[],
  anchor: number
): ValuePoint[] {
  const last = points[points.length - 1];
  if (!last || last.value <= 0) return points;
  const factor = anchor / last.value;
  return points.map((p) => ({ year: p.year, value: Math.round(p.value * factor) }));
}
