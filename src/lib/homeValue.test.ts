import { describe, expect, it } from "vitest";
import {
  AVM_SOURCE_LABEL,
  FALLBACK_VALUE_CAP_MULTIPLE,
  FORMULA_SOURCE_LABEL,
  anchorTimelineTo,
  estimateHomeValue,
  estimateValueTimeline,
  headlineHomeValue,
} from "./homeValue";

describe("the fallback formula's cap", () => {
  it("leaves a recent purchase alone", () => {
    // 2 years at CA's 6%: 500k -> ~561.8k, nowhere near the 1.25M ceiling.
    expect(estimateHomeValue(500_000, 2024, "CA", 2026)).toBe(561_800);
  });

  it("never lets an old purchase balloon past 2.5x what was paid", () => {
    // The bug this closes: a real $3.9M sale in 2007 compounded to $11.8M and
    // rendered in a big confident font. 2.5x is the ceiling now.
    const capped = estimateHomeValue(3_900_000, 2007, "CA", 2026);
    expect(capped).toBe(3_900_000 * FALLBACK_VALUE_CAP_MULTIPLE);
    expect(capped).toBeLessThan(4_000_000 * 3);
  });

  it("caps every state, not just the slow ones", () => {
    for (const state of ["ID", "UT", "FL", "CA", "NY", null]) {
      const v = estimateHomeValue(400_000, 1985, state, 2026);
      expect(v).toBeLessThanOrEqual(400_000 * FALLBACK_VALUE_CAP_MULTIPLE);
    }
  });

  it("flattens the timeline at the cap instead of curving forever", () => {
    const points = estimateValueTimeline(300_000, 1990, "CA", 2026);
    const last = points[points.length - 1];
    const secondLast = points[points.length - 2];
    expect(last.value).toBe(300_000 * FALLBACK_VALUE_CAP_MULTIPLE);
    expect(last.value).toBe(secondLast.value);
  });

  it("still returns the purchase price for the purchase year itself", () => {
    expect(estimateHomeValue(450_000, 2026, "TX", 2026)).toBe(450_000);
  });
});

describe("the headline value chooser", () => {
  const base = {
    marketValue: null as number | null,
    marketValueLow: null as number | null,
    marketValueHigh: null as number | null,
    purchasePrice: 500_000 as number | null,
    purchaseYear: 2015 as number | null,
    state: "CA" as string | null,
    currentYear: 2026,
  };

  it("prefers the AVM over the formula whenever one is on file", () => {
    const headline = headlineHomeValue({
      ...base,
      marketValue: 1_250_000,
      marketValueLow: 1_100_000,
      marketValueHigh: 1_400_000,
    })!;
    expect(headline.value).toBe(1_250_000);
    expect(headline.source).toBe("avm");
    expect(headline.low).toBe(1_100_000);
    expect(headline.high).toBe(1_400_000);
    expect(headline.sourceLabel).toBe(AVM_SOURCE_LABEL);
  });

  it("falls back to the formula when no AVM has landed", () => {
    const headline = headlineHomeValue(base)!;
    expect(headline.source).toBe("formula");
    expect(headline.value).toBe(
      estimateHomeValue(500_000, 2015, "CA", 2026)
    );
    expect(headline.low).toBeNull();
    expect(headline.high).toBeNull();
    expect(headline.sourceLabel).toBe(FORMULA_SOURCE_LABEL);
  });

  it("labels the two sources differently and honestly", () => {
    expect(AVM_SOURCE_LABEL).toBe("Estimate from RentCast");
    expect(FORMULA_SOURCE_LABEL).toBe("Estimate based on your purchase price");
  });

  it("has nothing to show with neither an AVM nor a purchase on file", () => {
    expect(
      headlineHomeValue({ ...base, purchasePrice: null, purchaseYear: null })
    ).toBeNull();
  });

  it("shows an AVM even when the owner never entered a purchase price", () => {
    const headline = headlineHomeValue({
      ...base,
      purchasePrice: null,
      purchaseYear: null,
      marketValue: 800_000,
    })!;
    expect(headline.value).toBe(800_000);
    expect(headline.source).toBe("avm");
  });

  it("measures the AVM against the purchase price, never against 'this year'", () => {
    // The AVM is a point-in-time reading with no history behind it, so the
    // only real comparison available is to what was actually paid. Any "up X
    // this year" for it would have to be modeled from the appreciation rate
    // and then presented as a measurement.
    const headline = headlineHomeValue({ ...base, marketValue: 1_060_000 })!;
    expect(headline.changeSince).toBe("purchase");
    expect(headline.change).toBe(1_060_000 - 500_000);
  });

  it("reports a negative change when the AVM lands below what they paid", () => {
    const headline = headlineHomeValue({ ...base, marketValue: 430_000 })!;
    expect(headline.change).toBe(430_000 - 500_000);
    expect(headline.change!).toBeLessThan(0);
    expect(headline.changeSince).toBe("purchase");
  });

  it("claims no movement at all for an AVM with no purchase price on file", () => {
    const headline = headlineHomeValue({
      ...base,
      purchasePrice: null,
      purchaseYear: null,
      marketValue: 800_000,
    })!;
    expect(headline.change).toBeNull();
    expect(headline.changeSince).toBeNull();
  });

  it("derives the formula's yearly change from the same capped model", () => {
    const headline = headlineHomeValue(base)!;
    expect(headline.changeSince).toBe("year");
    expect(headline.change).toBe(
      estimateHomeValue(500_000, 2015, "CA", 2026) -
        estimateHomeValue(500_000, 2015, "CA", 2025)
    );
  });

  it("reports no yearly movement once the fallback is pinned at the cap", () => {
    // Both years sit on the ceiling, so the honest answer is zero: the
    // estimate did not move, and pretending otherwise would invent growth.
    const headline = headlineHomeValue({
      ...base,
      purchasePrice: 400_000,
      purchaseYear: 1990,
    })!;
    expect(headline.value).toBe(400_000 * FALLBACK_VALUE_CAP_MULTIPLE);
    expect(headline.change).toBe(0);
  });
});

describe("the /value timeline chart", () => {
  it("anchors its last bar to the AVM so the chart can't contradict the headline", () => {
    // The bug: a $890k headline sitting directly above a highlighted
    // current-year bar reading $2.1M, because the chart was always the raw
    // purchase-price model.
    const modeled = estimateValueTimeline(300_000, 1990, "CA", 2026);
    expect(modeled[modeled.length - 1].value).toBe(750_000);

    const anchored = anchorTimelineTo(modeled, 890_000);
    expect(anchored[anchored.length - 1].value).toBe(890_000);
    expect(anchored).toHaveLength(modeled.length);
    expect(anchored[0].year).toBe(modeled[0].year);
  });

  it("keeps the shape of the curve while rescaling it", () => {
    const modeled = estimateValueTimeline(500_000, 2015, "CA", 2026);
    const anchored = anchorTimelineTo(modeled, 1_060_000);
    const factor = 1_060_000 / modeled[modeled.length - 1].value;
    for (let i = 0; i < modeled.length; i++) {
      expect(anchored[i].value).toBe(Math.round(modeled[i].value * factor));
      // Still monotonic: rescaling must not reorder anything.
      if (i > 0) expect(anchored[i].value).toBeGreaterThanOrEqual(anchored[i - 1].value);
    }
  });

  it("leaves a degenerate timeline alone rather than dividing by zero", () => {
    expect(anchorTimelineTo([], 500_000)).toEqual([]);
    const zeroed = [{ year: 2020, value: 0 }];
    expect(anchorTimelineTo(zeroed, 500_000)).toEqual(zeroed);
  });
});
