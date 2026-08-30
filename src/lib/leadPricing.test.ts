import { describe, expect, it } from "vitest";
import { agingDiscountPct, agingLeadFee, bestLeadDiscount } from "@/lib/leadPricing";
import { PRO_LEAD_DISCOUNT_PCT } from "@/lib/constants";

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

// The "best single discount, never stacked" rule. Owner's words: "if they
// buy [Pro], they start off with a 10% discount for leads. It does NOT
// stack with the 15-30%. More incentive to buy." Mirrors pro_lead_fee_cents()
// in supabase/migrations/0149_pro_lead_discount.sql.
describe("bestLeadDiscount", () => {
  it("gives a non-member no discount on a fresh lead", () => {
    expect(bestLeadDiscount(99, daysAgo(0), false)).toEqual({
      fee: 99,
      off: 0,
      kind: null,
    });
  });

  it("gives a member the flat discount on a fresh lead", () => {
    expect(bestLeadDiscount(99, daysAgo(0), true)).toEqual({
      fee: 89.1,
      off: PRO_LEAD_DISCOUNT_PCT,
      kind: "member",
    });
  });

  it("gives a non-member only the aging discount on an aged lead", () => {
    expect(bestLeadDiscount(99, daysAgo(4), false)).toEqual({
      fee: 84.15,
      off: 15,
      kind: "aging",
    });
    expect(bestLeadDiscount(99, daysAgo(8), false)).toEqual({
      fee: 69.3,
      off: 30,
      kind: "aging",
    });
  });

  it("never stacks: a member on an aged lead pays the BIGGER discount, not both added together", () => {
    // 3-day tier (15%) is bigger than the 10% member discount: aging wins,
    // and the fee is exactly what a non-member pays on the same lead - not
    // an extra 10% on top.
    const memberOn3Day = bestLeadDiscount(99, daysAgo(4), true);
    const nonMemberOn3Day = bestLeadDiscount(99, daysAgo(4), false);
    expect(memberOn3Day).toEqual({ fee: 84.15, off: 15, kind: "aging" });
    expect(memberOn3Day.fee).toBe(nonMemberOn3Day.fee);

    // 7-day tier (30%) still beats the 10% member discount: same story.
    const memberOn7Day = bestLeadDiscount(99, daysAgo(8), true);
    expect(memberOn7Day).toEqual({ fee: 69.3, off: 30, kind: "aging" });
    // If this ever double-discounted, the fee would be 99 * 0.7 * 0.9 =
    // 62.37 instead - explicitly rule that number out.
    expect(memberOn7Day.fee).not.toBeCloseTo(62.37);
  });

  it("a member beats aging only while the member percent is actually bigger", () => {
    // At today's numbers (10 vs. 15/30) this is every fresh or fresh-ish
    // lead: member wins from day 0 up to just under the 3-day tier.
    expect(bestLeadDiscount(50, daysAgo(2.9), true).kind).toBe("member");
    expect(bestLeadDiscount(50, daysAgo(3.1), true).kind).toBe("aging");
  });
});
