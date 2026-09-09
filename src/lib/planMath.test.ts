import { describe, expect, it } from "vitest";
import {
  PLUS_PLAN,
  PRO_PLAN,
  formatUsd,
  monthlyPerDay,
  perDayFromYearly,
  yearlyAsMonthly,
  yearlyPerDay,
  yearlyRunRate,
  yearlySavings,
} from "@/lib/constants";

// The pricing pages render savings, annual totals, and per-day figures from
// these helpers instead of typing numbers into JSX. That is a disclosure
// guarantee, not a convenience: a quoted saving that does not equal
// monthly x 12 minus yearly is an invented list price, which is exactly what
// the house rules forbid. These tests pin the arithmetic.

describe("yearlyRunRate", () => {
  it("is twelve charges at the real monthly price, to the cent", () => {
    // 4.99 * 12 is 59.88000000000001 in raw float math; the anchor the pages
    // print has to be 59.88 exactly.
    expect(yearlyRunRate(PLUS_PLAN)).toBe(59.88);
    expect(yearlyRunRate(PRO_PLAN)).toBe(359.88);
  });

  it("never quotes a list price nobody is charged", () => {
    // The anchor is derived from the monthly price and nothing else.
    expect(yearlyRunRate({ monthly: 10, yearly: 1 })).toBe(120);
  });
});

describe("yearlySavings", () => {
  it("is the honest monthly-x-12 minus yearly delta", () => {
    expect(yearlySavings(PLUS_PLAN)).toBe(19.89);
    expect(yearlySavings(PRO_PLAN)).toBe(120);
  });

  it("agrees with the run rate it is derived from", () => {
    for (const plan of [PLUS_PLAN, PRO_PLAN]) {
      expect(yearlySavings(plan)).toBe(
        Math.round((yearlyRunRate(plan) - plan.yearly) * 100) / 100
      );
    }
  });
});

describe("perDayFromYearly", () => {
  it("rounds UP to the cent so the line never undersells the price", () => {
    // 39.99 / 365 = $0.10956..., which must read as 11 cents, not 10.
    expect(perDayFromYearly(PLUS_PLAN.yearly)).toBe(0.11);
    // 239.88 / 365 = $0.65720..., which must read as 66 cents, not 65.
    expect(perDayFromYearly(PRO_PLAN.yearly)).toBe(0.66);
  });

  it("does not push an exact cent up by a float hair", () => {
    // 36.50 / 365 is exactly $0.10 a day. Naive Math.ceil on the raw float
    // would be at the mercy of 1e-15 noise and could print $0.11.
    expect(perDayFromYearly(36.5)).toBe(0.1);
    expect(perDayFromYearly(365)).toBe(1);
  });

  it("charges a fraction of a cent as a whole cent", () => {
    expect(perDayFromYearly(3.65)).toBe(0.01);
    expect(perDayFromYearly(0.01)).toBe(0.01);
  });
});

describe("the per-day figures the hero lines render", () => {
  it("reads as about $0.11 a day for homeowner Plus", () => {
    expect(formatUsd(yearlyPerDay(PLUS_PLAN))).toBe("$0.11");
  });

  it("reads as about $0.66 a day for OakTend Pro", () => {
    expect(formatUsd(yearlyPerDay(PRO_PLAN))).toBe("$0.66");
  });

  it("keeps the monthly per-day figure above the yearly one", () => {
    // The whole point of the annual hero: staying on monthly costs more per
    // day. If this ever inverts, the pricing copy is lying.
    for (const plan of [PLUS_PLAN, PRO_PLAN]) {
      expect(monthlyPerDay(plan)).toBeGreaterThan(yearlyPerDay(plan));
    }
    // Pro monthly annualised is 359.88 / 365 = $0.99 a day, which is what
    // makes any "less than a dollar a day" phrasing on that column truthful.
    expect(monthlyPerDay(PRO_PLAN)).toBe(0.99);
    expect(monthlyPerDay(PRO_PLAN)).toBeLessThan(1);
  });
});

describe("yearlyAsMonthly", () => {
  it("re-expresses the yearly price per month", () => {
    expect(yearlyAsMonthly(PLUS_PLAN)).toBe(3.33);
    // Pro's yearly price is exactly 12 x 19.99 on purpose.
    expect(yearlyAsMonthly(PRO_PLAN)).toBe(19.99);
    expect(yearlyAsMonthly(PRO_PLAN) * 12).toBeCloseTo(PRO_PLAN.yearly, 2);
  });

  it("stays below the real monthly price on both plans", () => {
    for (const plan of [PLUS_PLAN, PRO_PLAN]) {
      expect(yearlyAsMonthly(plan)).toBeLessThan(plan.monthly);
    }
  });
});

describe("formatUsd", () => {
  it("always shows two decimals", () => {
    expect(formatUsd(120)).toBe("$120.00");
    expect(formatUsd(4.9)).toBe("$4.90");
    expect(formatUsd(0.11)).toBe("$0.11");
  });
});
