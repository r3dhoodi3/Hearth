import { describe, expect, it } from "vitest";
import {
  reservePlan,
  reserveStatusCopy,
  dollarsFromCents,
  parseReserveInput,
  RESERVE_HORIZON_YEARS,
  RESERVE_MAX_CENTS,
  type ReserveCandidate,
} from "@/lib/forecastReserve";

const YEAR = 2026;

function item(over: Partial<ReserveCandidate> = {}): ReserveCandidate {
  return {
    system_type: "water_heater",
    yearsLeft: 3,
    replacementYear: YEAR + 3,
    futureCost: 3000,
    timingEstimated: false,
    ...over,
  };
}

describe("reservePlan set-aside", () => {
  it("spreads only the next five years over sixty months", () => {
    const plan = reservePlan(
      [
        item({ futureCost: 6000, yearsLeft: 2, replacementYear: YEAR + 2 }),
        // Outside the window, so it must not move the monthly figure.
        item({ system_type: "roof", futureCost: 20000, yearsLeft: 8, replacementYear: YEAR + 8 }),
      ],
      YEAR,
      null
    );
    expect(plan.nextFiveYearTotal).toBe(6000);
    expect(plan.monthlySetAside).toBe(100);
    expect(RESERVE_HORIZON_YEARS).toBe(5);
  });

  it("leaves guessed timing out of the window", () => {
    // The plan hangs on "this lands in year N". A midpoint placeholder is not
    // a date, so it cannot drive a monthly savings target.
    const plan = reservePlan(
      [item({ futureCost: 6000, timingEstimated: true })],
      YEAR,
      null
    );
    expect(plan.nextFiveYearTotal).toBe(0);
    expect(plan.nextBig).toBeNull();
  });

  it("aims the progress bar at the costliest item, not the soonest", () => {
    // A $300 sump pump due next spring is not what a reserve is for, and
    // pointing the bar at it would make an underfunded fund look finished.
    const plan = reservePlan(
      [
        item({ system_type: "sump_pump", futureCost: 300, yearsLeft: 1, replacementYear: YEAR + 1 }),
        item({ system_type: "hvac", futureCost: 9000, yearsLeft: 4, replacementYear: YEAR + 4 }),
      ],
      YEAR,
      null
    );
    expect(plan.nextBig?.system_type).toBe("hvac");
  });
});

describe("reservePlan status", () => {
  it("says unknown until the owner has entered a figure", () => {
    // Null is "has not told us", not "has nothing". Telling somebody they are
    // behind before they answered is how a planning tool loses trust.
    const plan = reservePlan([item()], YEAR, null);
    expect(plan.status).toBe("unknown");
    expect(plan.progressPct).toBe(0);
    expect(reserveStatusCopy(plan)).toMatch(/Tell us what you have set aside/);
  });

  it("says on track when the suggested set-aside gets there in time", () => {
    // $3,000 due in 36 months with $1,200 already saved needs $50 a month, and
    // the suggested set-aside is $3,000 / 60 = $50.
    const plan = reservePlan([item({ futureCost: 3000 })], YEAR, 1200);
    expect(plan.neededMonthly).toBe(50);
    expect(plan.monthlySetAside).toBe(50);
    expect(plan.status).toBe("on_track");
    expect(plan.behindByMonthly).toBe(0);
    expect(reserveStatusCopy(plan)).toMatch(/^On track/);
  });

  it("says how much a month behind, in dollars", () => {
    // $6,000 due in 24 months with nothing saved needs $250 a month; the
    // suggested set-aside is $6,000 / 60 = $100, so the gap is $150.
    const plan = reservePlan(
      [item({ futureCost: 6000, yearsLeft: 2, replacementYear: YEAR + 2 })],
      YEAR,
      0
    );
    expect(plan.neededMonthly).toBe(250);
    expect(plan.status).toBe("behind");
    expect(plan.behindByMonthly).toBe(150);
    expect(reserveStatusCopy(plan)).toBe(
      "Behind by about $150 a month to cover the next big one on time."
    );
  });

  it("treats zero saved as a real answer, not as unknown", () => {
    expect(reservePlan([item()], YEAR, 0).status).not.toBe("unknown");
  });

  it("caps progress at 100 and never goes negative", () => {
    const over = reservePlan([item({ futureCost: 3000 })], YEAR, 9000);
    expect(over.progressPct).toBe(100);
    expect(over.status).toBe("on_track");
    expect(over.neededMonthly).toBe(0);
  });

  it("never divides by zero for something already due", () => {
    const plan = reservePlan(
      [item({ yearsLeft: 0, replacementYear: YEAR, futureCost: 2400 })],
      YEAR,
      0
    );
    expect(plan.monthsUntilNextBig).toBe(1);
    expect(Number.isFinite(plan.neededMonthly)).toBe(true);
    expect(plan.neededMonthly).toBe(2400);
  });

  it("says something useful when nothing big is coming", () => {
    const plan = reservePlan([], YEAR, 500);
    expect(plan.status).toBe("unknown");
    expect(reserveStatusCopy(plan)).toMatch(/head start/);
  });

  it("carries no em dashes in any status line", () => {
    const lines = [
      reserveStatusCopy(reservePlan([item()], YEAR, null)),
      reserveStatusCopy(reservePlan([item({ futureCost: 3000 })], YEAR, 1200)),
      reserveStatusCopy(reservePlan([item({ futureCost: 60000 })], YEAR, 0)),
      reserveStatusCopy(reservePlan([], YEAR, null)),
    ];
    for (const line of lines) {
      expect(/[–—]/.test(line), line).toBe(false);
    }
  });
});

describe("reserve input handling", () => {
  it("converts cents to dollars and keeps null meaning null", () => {
    expect(dollarsFromCents(450000)).toBe(4500);
    expect(dollarsFromCents(0)).toBe(0);
    expect(dollarsFromCents(null)).toBeNull();
    expect(dollarsFromCents(undefined)).toBeNull();
  });

  it("accepts what people actually type", () => {
    expect(parseReserveInput("4500")).toBe(450000);
    expect(parseReserveInput("$4,500")).toBe(450000);
    expect(parseReserveInput(" 4500.50 ")).toBe(450050);
    expect(parseReserveInput("0")).toBe(0);
  });

  it("treats an empty field as clearing the figure, not as zero", () => {
    expect(parseReserveInput("")).toBeNull();
    expect(parseReserveInput("   ")).toBeNull();
  });

  it("rejects anything that is not a plain positive amount", () => {
    expect(parseReserveInput("-100")).toBe("invalid");
    expect(parseReserveInput("lots")).toBe("invalid");
    expect(parseReserveInput("1e9")).toBe("invalid");
    expect(parseReserveInput("4500.555")).toBe("invalid");
    // Past the ceiling the migration's CHECK constraint also enforces.
    expect(parseReserveInput(String(RESERVE_MAX_CENTS / 100 + 1))).toBe("invalid");
    expect(parseReserveInput(String(RESERVE_MAX_CENTS / 100))).toBe(
      RESERVE_MAX_CENTS
    );
  });
});
