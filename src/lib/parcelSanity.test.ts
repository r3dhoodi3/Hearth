import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_CEILING,
  BUILDING_RECORD_NOTICE,
  IMPLAUSIBLE_FLOOR,
  isBuildingLevelHome,
  isImplausibleHomeFigure,
  plausibleHomeFigure,
} from "./parcelSanity";

// The numbers below are the ones a real tester was actually shown at
// 1770 S Harbor Blvd Unit 204, Anaheim - a condo in a large mixed-use parcel.
// /value printed "Bought for $34,000,000 in 2017, down $33,201,000 since"
// under a $799,000 estimate; /taxes printed a $36,410,541 county assessment
// and a $39,836,419 Prop 13 baseline above a green "looks in line".
const TESTER = {
  unit: "204",
  propertyType: "multi_family",
  sqft: 1_100,
  estimate: 799_000,
};
const TESTER_PURCHASE_PRICE = 34_000_000;
const TESTER_ASSESSED_VALUE = 36_410_541;
const TESTER_PROP13_BASELINE = 39_836_419;

describe("isBuildingLevelHome", () => {
  it("is true for any home with a unit number", () => {
    expect(isBuildingLevelHome({ unit: "204" })).toBe(true);
    expect(isBuildingLevelHome({ unit: "4B", propertyType: "single_family" })).toBe(
      true
    );
  });

  it("is true for a condo or multi-family type with no unit entered", () => {
    expect(isBuildingLevelHome({ propertyType: "condo" })).toBe(true);
    expect(isBuildingLevelHome({ propertyType: "multi_family" })).toBe(true);
  });

  it("accepts the provider's own wording as well as Hearth's enum", () => {
    expect(isBuildingLevelHome({ propertyType: "Multi-Family" })).toBe(true);
    expect(isBuildingLevelHome({ propertyType: "Apartment" })).toBe(true);
    expect(isBuildingLevelHome({ propertyType: "Condo" })).toBe(true);
  });

  it("is false for a plain single-family home", () => {
    expect(isBuildingLevelHome({ propertyType: "single_family" })).toBe(false);
    expect(isBuildingLevelHome({ unit: "  ", propertyType: "townhouse" })).toBe(
      false
    );
    expect(isBuildingLevelHome({})).toBe(false);
  });
});

describe("the tester's own numbers", () => {
  it("rejects the $34,000,000 purchase price under a $799,000 estimate", () => {
    expect(isImplausibleHomeFigure(TESTER_PURCHASE_PRICE, TESTER)).toBe(true);
    expect(plausibleHomeFigure(TESTER_PURCHASE_PRICE, TESTER)).toBeNull();
  });

  it("rejects the $36,410,541 county assessment", () => {
    expect(isImplausibleHomeFigure(TESTER_ASSESSED_VALUE, TESTER)).toBe(true);
    expect(plausibleHomeFigure(TESTER_ASSESSED_VALUE, TESTER)).toBeNull();
  });

  it("rejects the $39,836,419 Prop 13 baseline derived from that price", () => {
    expect(isImplausibleHomeFigure(TESTER_PROP13_BASELINE, TESTER)).toBe(true);
  });

  it("still rejects them with no estimate on file", () => {
    const noEstimate = { ...TESTER, estimate: null };
    expect(isImplausibleHomeFigure(TESTER_PURCHASE_PRICE, noEstimate)).toBe(true);
    expect(isImplausibleHomeFigure(TESTER_ASSESSED_VALUE, noEstimate)).toBe(true);
  });

  it("still rejects them from the unit number alone, with no property type", () => {
    const unitOnly = { unit: "204", estimate: 799_000 };
    expect(isImplausibleHomeFigure(TESTER_PURCHASE_PRICE, unitOnly)).toBe(true);
  });

  it("keeps a real price for the same condo", () => {
    expect(plausibleHomeFigure(680_000, TESTER)).toBe(680_000);
    expect(plausibleHomeFigure(120_000, TESTER)).toBe(120_000);
  });
});

describe("the building-level rule", () => {
  const condo = { propertyType: "condo", estimate: 400_000 };

  it("uses 10x the estimate when that is above the floor", () => {
    const highEstimate = { propertyType: "condo", estimate: 1_000_000 };
    // 10x $1M is $10M, so $9M passes where it would fail on the floor alone.
    expect(isImplausibleHomeFigure(9_000_000, highEstimate)).toBe(false);
    expect(isImplausibleHomeFigure(11_000_000, highEstimate)).toBe(true);
  });

  it("uses the floor when 10x the estimate is below it", () => {
    // 10x $400k is $4M, under the $5M floor, so the floor is the ceiling.
    expect(isImplausibleHomeFigure(4_500_000, condo)).toBe(false);
    expect(isImplausibleHomeFigure(IMPLAUSIBLE_FLOOR, condo)).toBe(false);
    expect(isImplausibleHomeFigure(IMPLAUSIBLE_FLOOR + 1, condo)).toBe(true);
  });

  it("leaves a single-family home alone below the absolute ceiling", () => {
    const house = { propertyType: "single_family", sqft: 1_800, estimate: 900_000 };
    expect(isImplausibleHomeFigure(20_000_000, house)).toBe(false);
  });
});

describe("the absolute ceiling", () => {
  it("rejects a $25M+ figure on a small home of any type", () => {
    const small = { propertyType: "single_family", sqft: 1_800 };
    expect(isImplausibleHomeFigure(ABSOLUTE_CEILING + 1, small)).toBe(true);
    expect(isImplausibleHomeFigure(ABSOLUTE_CEILING, small)).toBe(false);
  });

  it("does not fire when the size is unknown", () => {
    // An unknown size is not evidence of a small home, and this rule has
    // nothing else to go on.
    expect(
      isImplausibleHomeFigure(30_000_000, { propertyType: "single_family" })
    ).toBe(false);
  });

  it("does not fire on a genuinely large property", () => {
    expect(
      isImplausibleHomeFigure(30_000_000, {
        propertyType: "single_family",
        sqft: 12_000,
      })
    ).toBe(false);
  });
});

describe("absent and malformed figures", () => {
  it("treats null, undefined, zero and NaN as absent, not implausible", () => {
    expect(isImplausibleHomeFigure(null, TESTER)).toBe(false);
    expect(isImplausibleHomeFigure(undefined, TESTER)).toBe(false);
    expect(isImplausibleHomeFigure(0, TESTER)).toBe(false);
    expect(isImplausibleHomeFigure(Number.NaN, TESTER)).toBe(false);
    expect(plausibleHomeFigure(null, TESTER)).toBeNull();
    expect(plausibleHomeFigure(Number.NaN, TESTER)).toBeNull();
  });
});

describe("the notice", () => {
  it("says what happened and what the owner can do", () => {
    expect(BUILDING_RECORD_NOTICE).toContain("whole building");
    expect(BUILDING_RECORD_NOTICE).toContain("Home details");
    // House style: no em dashes or en dashes anywhere in user-facing copy.
    // Checked by codepoint so this file does not itself contain the
    // characters it bans.
    expect(BUILDING_RECORD_NOTICE).not.toContain(String.fromCharCode(0x2014));
    expect(BUILDING_RECORD_NOTICE).not.toContain(String.fromCharCode(0x2013));
  });
});
