// Pure forecasting math for the "Home Cost Forecast + Repair Fund" feature
// (OakTend Plus). No DB access here - the page loads home_systems and passes
// them in, along with the current year (never call argless `new Date()`).
//
// Reuses the same lifespan and cost tables the Home Health score is built on
// (src/lib/health.ts), so a system's forecasted replacement year and cost
// range always agree with what the health tab already says about it.
//
// Two things make this more than a generic "roofs cost $10k" calculator:
// regional cost adjustment (a roof in Honolulu is not a roof in Little Rock)
// and inflation to the actual replacement year (a furnace due in 2035 will
// not cost 2026 prices). Both are pure math so the whole feature stays
// testable and server-render friendly.
import type { HomeSystem, Issue } from "@/lib/database.types";
import { DEFAULT_LIFESPANS, REPLACEMENT_INFO, openIssueFor } from "@/lib/health";

// The slice of an open issue buildForecast actually needs. Callers (the
// forecast page) query the full `issues` table but only these fields matter
// here, matching what health.ts's openIssueFor accepts.
type OpenIssueLite = Pick<
  Issue,
  "id" | "system_id" | "category" | "severity" | "description"
>;

// Rough construction/labor cost index by state, national average = 1.0. Used
// to scale national cost ranges toward what an owner in that state actually
// pays. Ballpark, not a quote: real costs vary by city and contractor.
export const STATE_COST_MULTIPLIERS: Record<string, number> = {
  HI: 1.4,
  CA: 1.3,
  NY: 1.25,
  MA: 1.2,
  NJ: 1.2,
  CT: 1.2,
  WA: 1.2,
  AK: 1.2,
  DC: 1.15,
  CO: 1.1,
  OR: 1.1,
  MD: 1.1,
  IL: 1.1,
  RI: 1.1,
  NV: 1.05,
  NH: 1.05,
  VT: 1.05,
  ME: 1.0,
  PA: 1.0,
  DE: 1.0,
  VA: 1.0,
  FL: 1.0,
  MN: 1.0,
  UT: 1.0,
  AZ: 1.0,
  NC: 0.95,
  GA: 0.95,
  OH: 0.95,
  MI: 0.95,
  WI: 0.95,
  ND: 0.95,
  MT: 0.95,
  WY: 0.95,
  ID: 0.95,
  TX: 0.95,
  SC: 0.9,
  TN: 0.9,
  IN: 0.9,
  IA: 0.9,
  MO: 0.9,
  NE: 0.9,
  SD: 0.9,
  NM: 0.9,
  LA: 0.9,
  MS: 0.85,
  AR: 0.85,
  AL: 0.85,
  OK: 0.85,
  KY: 0.85,
  WV: 0.85,
  KS: 0.85,
};

// Full state names for the two-letter codes above, so the page can say
// "adjusted for California" instead of just "CA".
export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "the District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// National-average cost index for a state, defaulting to 1.0 when the state
// is missing or not one we have data for.
export function stateMultiplier(state: string | null | undefined): number {
  if (!state) return 1.0;
  return STATE_COST_MULTIPLIERS[state.toUpperCase()] ?? 1.0;
}

export function stateName(state: string | null | undefined): string | null {
  if (!state) return null;
  return STATE_NAMES[state.toUpperCase()] ?? state.toUpperCase();
}

// Rough long-run inflation for construction materials/labor, used to project
// today's cost ranges out to the year a system will actually be replaced.
const INFLATION_RATE = 0.03;

function inflate(amount: number, years: number): number {
  return amount * Math.pow(1 + INFLATION_RATE, Math.max(0, years));
}

export interface ForecastItem {
  system: HomeSystem;
  system_type: string;
  age: number | null;
  lifespan: number;
  yearsLeft: number;
  replacementYear: number;
  // Regional-adjusted cost range, in today's dollars.
  costLow: number;
  costHigh: number;
  costMid: number;
  // Same as costMid, named for clarity next to futureCost.
  todayCost: number;
  // costMid compounded at ~3%/yr out to replacementYear, so the plan reflects
  // what the repair will actually cost when it happens, not what it costs now.
  futureCost: number;
  // True when the timing is a guess: no install year and no condition rating
  // to anchor it, so yearsLeft is just "midpoint of a typical lifespan". The
  // cost range is still real; the WHEN is not, and the page should say so
  // instead of quoting a confident replacement year.
  timingEstimated: boolean;
}

export interface PriorityItem {
  item: ForecastItem;
  reason: string;
}

export interface YearlySpend {
  year: number;
  amount: number; // sum of futureCost for items landing on this year
}

export interface Forecast {
  horizonYears: number;
  timeline: ForecastItem[]; // every system with a cost range, soonest first
  dueSoon: ForecastItem[]; // yearsLeft <= 1, real data only (no guessed timing)
  startHere: PriorityItem[]; // top 2-3 items to act on first, with why
  yearlySpend: YearlySpend[]; // one entry per year of the horizon, for a bar chart
  totalMidCost: number; // sum of future (inflation-adjusted) costs due within the horizon
  monthlySetAside: number; // recommended monthly repair-fund contribution
  stateMultiplier: number; // regional cost multiplier applied (1.0 = national average)
  // How many systems have timingEstimated timing (no install year, no
  // condition signal). Their costs are still in the totals, so the page must
  // disclose that their placement on the timeline is rough.
  estimatedTimingCount: number;
}

// Years left before a system likely needs replacing, adjusted for the
// owner-reported condition AND any open issue reported against it (the same
// live signal Home reads via health.ts's openIssueFor/isMustDo - a resolved
// issue simply stops being passed in here, since callers only pass open
// ones). Mirrors health.ts's effectiveYearsLeft, but takes install_year/
// condition/issue directly and always returns a number: a system with no
// install year is placed at the midpoint of its typical lifespan so it still
// lands somewhere on the timeline instead of disappearing from the forecast.
// When neither an install year nor a worrying condition rating nor an open
// issue backs that placement up, timingEstimated is true: the WHEN is a
// guess and downstream code must treat it that way (no due-soon urgency, no
// confident replacement year on the page).
function yearsLeftFor(
  system: Pick<HomeSystem, "system_type" | "install_year" | "condition_rating">,
  currentYear: number,
  lifespan: number,
  openIssue: OpenIssueLite | null = null
): { age: number | null; yearsLeft: number; timingEstimated: boolean } {
  const age = system.install_year != null ? currentYear - system.install_year : null;
  const ageBased = age != null ? lifespan - age : Math.round(lifespan / 2);

  const c = system.condition_rating;
  let cap: number | null = null;
  if (c === 1) cap = 0; // failing - now
  else if (c === 2) cap = 2; // worn - within ~2 years
  else if (c === 3) cap = 5; // fair - within ~5 years

  // A reported problem is real data too, capped the same way a bad condition
  // rating is (urgent mirrors "failing", medium mirrors "worn", low mirrors
  // "fair"). Combine with the condition cap by taking whichever is sooner.
  if (openIssue) {
    const issueCap =
      openIssue.severity === "urgent" ? 0 : openIssue.severity === "medium" ? 2 : 5;
    cap = cap == null ? issueCap : Math.min(cap, issueCap);
  }

  const yearsLeft = cap == null ? ageBased : Math.min(ageBased, cap);
  // No install year AND no condition cap AND no open issue: the midpoint
  // placement is pure guesswork. (A bad condition rating or an open issue is
  // real data, so either one still counts.)
  const timingEstimated = age == null && cap == null;
  return { age, yearsLeft, timingEstimated };
}

// One-line reason a "start here" item is ranked where it is.
function priorityReason(item: ForecastItem, isCostliest: boolean): string {
  if (item.yearsLeft <= 0) {
    return "Already due. Getting quotes now avoids a last-minute scramble.";
  }
  if (item.yearsLeft <= 1) {
    return "Due within the year. Start budgeting or getting quotes now.";
  }
  if (isCostliest) {
    return "Your costliest upcoming project. Getting ahead of it protects your budget.";
  }
  return `About ${item.yearsLeft} years out, but worth planning for early.`;
}

// Build the full cost forecast for one property's systems over the given
// horizon (default 10 years). `currentYear` must be passed in by the caller
// (e.g. new Date(Date.now()).getFullYear()). `state` is the property's
// two-letter state code, used to regionally adjust national cost ranges;
// pass null/undefined when unknown and national averages are used instead.
// `openIssues` should be that property's issues with status="open" only
// (same query shape as the dashboard) - passing resolved ones in would
// re-flag a system the owner already fixed, since matching happens by
// openIssueFor, not by status.
export function buildForecast(
  systems: HomeSystem[],
  currentYear: number,
  state?: string | null,
  horizonYears = 10,
  openIssues: OpenIssueLite[] = []
): Forecast {
  const multiplier = stateMultiplier(state);

  const items: ForecastItem[] = systems.map((system) => {
    const lifespan =
      system.expected_lifespan_years ?? DEFAULT_LIFESPANS[system.system_type] ?? 20;
    const openIssue = openIssueFor(system, openIssues);
    const { age, yearsLeft, timingEstimated } = yearsLeftFor(
      system,
      currentYear,
      lifespan,
      openIssue
    );
    const cost = REPLACEMENT_INFO[system.system_type] ?? { low: 1000, high: 5000 };
    const costLow = Math.round(cost.low * multiplier);
    const costHigh = Math.round(cost.high * multiplier);
    const costMid = Math.round((costLow + costHigh) / 2);
    const replacementYear = currentYear + Math.max(0, yearsLeft);
    const futureCost = Math.round(inflate(costMid, replacementYear - currentYear));

    return {
      system,
      system_type: system.system_type,
      age,
      lifespan,
      yearsLeft,
      replacementYear,
      costLow,
      costHigh,
      costMid,
      todayCost: costMid,
      futureCost,
      timingEstimated,
    };
  });

  const timeline = [...items].sort((a, b) => a.yearsLeft - b.yearsLeft);

  // "Due soon" is an urgency call, so it only includes systems whose timing
  // is backed by real data. A guessed midpoint never creates urgency.
  const dueSoon = timeline.filter((i) => !i.timingEstimated && i.yearsLeft <= 1);

  // "Within the horizon" means replacementYear lands in one of the chart's
  // buckets: currentYear .. currentYear + horizonYears - 1, i.e. yearsLeft
  // strictly less than horizonYears. Using <= here would count an item due in
  // exactly horizonYears years in the total and set-aside while the bar chart
  // (which only has horizonYears buckets) silently drops it, so the bars
  // would not reconcile with the headline number.
  //
  // Guessed-timing items stay in the total even when their placeholder
  // midpoint lands past the horizon: we do not know WHEN that roof is due,
  // only that it will be, and the fund should still cover it. The page
  // discloses this via estimatedTimingCount.
  const withinHorizon = timeline.filter(
    (i) => i.yearsLeft < horizonYears || i.timingEstimated
  );
  const totalMidCost = withinHorizon.reduce((sum, i) => sum + i.futureCost, 0);

  const monthlySetAside = Math.round(totalMidCost / (horizonYears * 12));

  const estimatedTimingCount = items.filter((i) => i.timingEstimated).length;

  // Top 2-3 items to act on first: soonest due, then costliest as a
  // tiebreaker, mirroring how an owner should actually triage a list.
  // Guessed-timing items never make this list: "act now" advice has to
  // rest on real dates or a real condition rating, not a midpoint guess.
  const ranked = timeline
    .filter((i) => !i.timingEstimated)
    .sort((a, b) => {
      if (a.yearsLeft !== b.yearsLeft) return a.yearsLeft - b.yearsLeft;
      return b.futureCost - a.futureCost;
    });
  const startHereItems = ranked.slice(0, Math.min(3, ranked.length));
  const costliestId =
    startHereItems.length > 0
      ? startHereItems.reduce((a, b) => (b.futureCost > a.futureCost ? b : a)).system.id
      : null;
  const startHere: PriorityItem[] = startHereItems.map((item) => ({
    item,
    reason: priorityReason(item, item.system.id === costliestId),
  }));

  // One bucket per year of the horizon, summing future dollars so the bar
  // chart shows when the money is actually needed, not just today's prices.
  const yearlySpend: YearlySpend[] = Array.from({ length: horizonYears }, (_, i) => {
    const year = currentYear + i;
    const amount = items
      .filter((item) => item.replacementYear === year)
      .reduce((sum, item) => sum + item.futureCost, 0);
    return { year, amount };
  });

  return {
    horizonYears,
    timeline,
    dueSoon,
    startHere,
    yearlySpend,
    totalMidCost,
    monthlySetAside,
    stateMultiplier: multiplier,
    estimatedTimingCount,
  };
}
