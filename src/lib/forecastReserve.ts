// Repair reserve math for the cost forecast.
//
// WHY A FIVE-YEAR WINDOW, NOT TEN: the headline set-aside on the forecast page
// spreads the whole ten-year total over ten years, which is the right number
// for "what should I be saving forever". It is the wrong number for "am I
// actually going to have the money when the water heater goes", because the
// bills are not spread evenly: most homes have a cluster in the next few years
// and a quiet stretch after it. The reserve plan looks at the next five years
// only, so the monthly figure answers the question the owner is actually asking
// while they are looking at their own timeline.
//
// Pure math, no DB access and no clock: the caller passes currentYear in, the
// same convention buildForecast uses.
//
// No streaks, no badges, no "keep it up". This is a savings target, and a
// savings target that congratulates you is a savings target you stop believing.

// What the plan needs off a forecast item. Structural rather than importing
// ForecastItem so the tests can pass plain objects.
export interface ReserveCandidate {
  system_type: string;
  yearsLeft: number;
  replacementYear: number;
  // Inflation-adjusted cost in the year it actually lands.
  futureCost: number;
  timingEstimated: boolean;
}

export const RESERVE_HORIZON_YEARS = 5;

export interface ReservePlan {
  // Sum of futureCost for everything landing inside the next five years.
  nextFiveYearTotal: number;
  // What to put away every month to cover that in five years.
  monthlySetAside: number;
  // What the owner says they have set aside, in whole dollars. Null when they
  // have not told us yet, which is a real state: the page asks rather than
  // assuming zero.
  savedDollars: number | null;
  // The next big-ticket item inside the window, which is what the progress bar
  // is measured against. Null when nothing lands inside five years.
  nextBig: ReserveCandidate | null;
  // 0 to 100, saved against nextBig's future cost. 0 when nothing is saved yet
  // or there is no next item.
  progressPct: number;
  // Whole months from today until nextBig lands, floor of 1 so the math never
  // divides by zero for something already due.
  monthsUntilNextBig: number;
  // What it would actually take per month to cover nextBig on time from what is
  // already saved.
  neededMonthly: number;
  // "on_track"  - the suggested set-aside covers nextBig in time.
  // "behind"    - it does not, and behindByMonthly says by how much.
  // "unknown"   - no saved figure entered yet, or nothing due inside the window.
  status: "on_track" | "behind" | "unknown";
  // Extra dollars per month needed on top of monthlySetAside. 0 unless behind.
  behindByMonthly: number;
}

// Build the reserve plan.
//
// `savedDollars` is whole dollars, or null when the owner has not entered a
// figure. It is deliberately NOT defaulted to 0: "I have not said" and "I have
// nothing" are different, and telling somebody they are behind before they have
// answered is how a planning tool loses trust.
export function reservePlan(
  items: ReserveCandidate[],
  currentYear: number,
  savedDollars: number | null
): ReservePlan {
  // Guessed timing stays OUT of the reserve window. The whole plan hangs on
  // "this lands in year N", and a midpoint placeholder is not a date. Its cost
  // is still in the page's ten-year total, which is where an unknown-timing
  // system honestly belongs.
  const inWindow = items.filter(
    (i) => !i.timingEstimated && i.yearsLeft < RESERVE_HORIZON_YEARS
  );

  const nextFiveYearTotal = inWindow.reduce((sum, i) => sum + i.futureCost, 0);
  const monthlySetAside = Math.round(
    nextFiveYearTotal / (RESERVE_HORIZON_YEARS * 12)
  );

  // "Next big item" is the costliest thing in the window, not the soonest. A
  // $300 sump pump due next spring is not what the reserve exists for, and
  // aiming the progress bar at it would make a badly underfunded reserve look
  // finished.
  const nextBig =
    inWindow.length > 0
      ? inWindow.reduce((a, b) => (b.futureCost > a.futureCost ? b : a))
      : null;

  const monthsUntilNextBig = nextBig
    ? Math.max(1, (nextBig.replacementYear - currentYear) * 12)
    : 0;

  const progressPct =
    nextBig && savedDollars != null && nextBig.futureCost > 0
      ? Math.max(0, Math.min(100, Math.round((savedDollars / nextBig.futureCost) * 100)))
      : 0;

  const neededMonthly =
    nextBig && savedDollars != null
      ? Math.max(
          0,
          Math.round(
            (nextBig.futureCost - savedDollars) / monthsUntilNextBig
          )
        )
      : 0;

  let status: ReservePlan["status"] = "unknown";
  let behindByMonthly = 0;
  if (nextBig && savedDollars != null) {
    if (neededMonthly <= monthlySetAside) {
      status = "on_track";
    } else {
      status = "behind";
      behindByMonthly = neededMonthly - monthlySetAside;
    }
  }

  return {
    nextFiveYearTotal,
    monthlySetAside,
    savedDollars,
    nextBig,
    progressPct,
    monthsUntilNextBig,
    neededMonthly,
    status,
    behindByMonthly,
  };
}

// The one line the card prints under the progress bar. Kept here rather than in
// the page so the copy is covered by the same test as the math it describes.
export function reserveStatusCopy(plan: ReservePlan): string {
  if (plan.status === "on_track") {
    return "On track. Keep putting that aside and the next big one is covered.";
  }
  if (plan.status === "behind") {
    return `Behind by about $${plan.behindByMonthly.toLocaleString()} a month to cover the next big one on time.`;
  }
  if (plan.nextBig == null) {
    return "Nothing big lands in the next five years, so anything you set aside is a head start.";
  }
  return "Tell us what you have set aside and we will show you where you stand.";
}

// Whole dollars from the cents column stored on properties. Null in, null out:
// see the savedDollars comment above for why the difference matters.
export function dollarsFromCents(cents: number | null | undefined): number | null {
  if (cents == null) return null;
  if (!Number.isFinite(cents)) return null;
  return Math.round(cents / 100);
}

// Hard ceiling on what the reserve field accepts, mirrored in the migration's
// CHECK constraint. $10,000,000 is far past any real repair fund and stops a
// pasted number from making the progress bar or the copy nonsense.
export const RESERVE_MAX_CENTS = 1_000_000_000;

// Parse the "what you have saved" field. Accepts what people actually type
// ("$4,500", "4500.50", " 4500 ") and rejects everything else, including
// negatives. Returns cents, or null for an empty field (which CLEARS the stored
// figure), or the string "invalid" so the caller can say so instead of writing
// a silent zero.
export function parseReserveInput(raw: string): number | null | "invalid" {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return "invalid";
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents) || cents < 0) return "invalid";
  if (cents > RESERVE_MAX_CENTS) return "invalid";
  return cents;
}
