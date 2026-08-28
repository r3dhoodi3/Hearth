import { describe, expect, it } from "vitest";
import { homeValueEquityLine } from "@/lib/homeDigestLine";

// THE BUILDING-RECORD GATE (src/lib/parcelSanity.ts), on the monthly home
// digest. Before this fix, the digest's "Your home's estimated value is
// $X" line was built straight from the stored purchase_price, so a condo or
// multi-family home whose county record covers the whole building (a unit
// number, or a building-level property type) could land a building-scale
// purchase price - the tester's own $34,000,000 for a $799,000 condo - in a
// monthly email. homeValueEquityLine now runs that price through
// plausibleHomeFigure first and omits the line entirely when it fails.
//
// homeValueEquityLine lives in src/lib/homeDigestLine.ts, not the route
// module: a Next.js route file may only export its HTTP handlers and a small
// set of config names, so this test imports the pure helper directly and
// needs no mocks for the admin Supabase client or notify.
describe("homeValueEquityLine", () => {
  const BASE = {
    purchaseYear: 2017,
    mortgageBalance: null as number | null,
    marketValue: 799_000,
    marketValueLow: null,
    marketValueHigh: null,
    unit: "204",
    propertyType: "multi_family",
    sqft: 1_100,
    state: "CA",
    currentYear: 2026,
  };

  it("omits the line for a building-level purchase price far above the AVM estimate", () => {
    expect(
      homeValueEquityLine({ ...BASE, purchasePrice: 34_000_000 })
    ).toBeNull();
  });

  it("still omits the line with no estimate on file at all", () => {
    expect(
      homeValueEquityLine({
        ...BASE,
        marketValue: null,
        purchasePrice: 34_000_000,
      })
    ).toBeNull();
  });

  it("builds the estimated-value line for a plausible price", () => {
    const line = homeValueEquityLine({ ...BASE, purchasePrice: 680_000 });
    // market_value is on file, so headlineHomeValue picks the AVM ($799,000)
    // over the formula fallback.
    expect(line).toBe("Your home's estimated value is $799,000.");
  });

  it("adds the equity clause only when a mortgage balance leaves positive equity", () => {
    const line = homeValueEquityLine({
      ...BASE,
      purchasePrice: 680_000,
      mortgageBalance: 300_000,
    });
    expect(line).toBe(
      "Your home's estimated value is $799,000, about $499,000 of it equity."
    );
  });

  it("returns null with no purchase price or no purchase year on file", () => {
    expect(homeValueEquityLine({ ...BASE, purchasePrice: null })).toBeNull();
    expect(
      homeValueEquityLine({ ...BASE, purchasePrice: 680_000, purchaseYear: null })
    ).toBeNull();
  });

  it("does not gate a plain single-family home's large-but-real price", () => {
    const line = homeValueEquityLine({
      purchaseYear: 2015,
      mortgageBalance: null,
      marketValue: null,
      marketValueLow: null,
      marketValueHigh: null,
      unit: null,
      propertyType: "single_family",
      sqft: 1_800,
      state: "TX",
      currentYear: 2026,
      purchasePrice: 250_000,
    });
    expect(line).not.toBeNull();
    expect(line).toContain("Your home's estimated value is");
  });
});
