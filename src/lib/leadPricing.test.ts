import { describe, expect, it } from "vitest";
import { agingDiscountPct, agingLeadFee } from "@/lib/leadPricing";

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

describe("agingDiscountPct", () => {
  it("gives no discount on a fresh lead", () => {
    expect(agingDiscountPct(daysAgo(0))).toBe(0);
    expect(agingDiscountPct(daysAgo(2.9))).toBe(0);
  });

  it("applies the 3-day tier", () => {
    expect(agingDiscountPct(daysAgo(3.1))).toBe(15);
    expect(agingDiscountPct(daysAgo(6.9))).toBe(15);
  });

  it("applies the 7-day tier and does not stack past it", () => {
    expect(agingDiscountPct(daysAgo(7.1))).toBe(30);
    expect(agingDiscountPct(daysAgo(90))).toBe(30);
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(agingDiscountPct(daysAgo(10).toISOString())).toBe(30);
  });
});

describe("agingLeadFee", () => {
  it("returns the base fee untouched when the lead is fresh", () => {
    expect(agingLeadFee(20, daysAgo(1))).toEqual({ base: 20, fee: 20, off: 0 });
  });

  it("marks the fee down by the tier percent", () => {
    expect(agingLeadFee(20, daysAgo(4))).toEqual({ base: 20, fee: 17, off: 15 });
    expect(agingLeadFee(20, daysAgo(8))).toEqual({ base: 20, fee: 14, off: 30 });
  });

  it("rounds the discounted fee to whole cents", () => {
    const { fee } = agingLeadFee(19.99, daysAgo(8));
    expect(fee).toBe(13.99);
    expect(Number.isInteger(Math.round(fee * 100))).toBe(true);
  });
});
