import { describe, expect, it } from "vitest";
import { FALLBACK_PROPERTY_TYPE, defaultPropertyType } from "./propertyType";
import { PROPERTY_TYPES } from "./constants";

describe("defaultPropertyType", () => {
  it("defaults a home with a unit number to Condo", () => {
    // The tester's case: RentCast returned the mixed-use building as
    // "Apartment" (multi_family) for a condo at unit 204.
    expect(defaultPropertyType("multi_family", true)).toBe("condo");
    expect(defaultPropertyType(null, true)).toBe("condo");
    expect(defaultPropertyType("", true)).toBe("condo");
  });

  it("keeps a unit-level type the record actually gave", () => {
    expect(defaultPropertyType("condo", true)).toBe("condo");
    expect(defaultPropertyType("townhouse", true)).toBe("townhouse");
  });

  it("keeps the record's type when there is no unit", () => {
    expect(defaultPropertyType("multi_family", false)).toBe("multi_family");
    expect(defaultPropertyType("single_family", false)).toBe("single_family");
  });

  it("falls back to single family when nothing is known", () => {
    expect(defaultPropertyType(null, false)).toBe(FALLBACK_PROPERTY_TYPE);
    expect(FALLBACK_PROPERTY_TYPE).toBe("single_family");
  });

  it("only ever returns a value the dropdown and the server both accept", () => {
    const allowed = PROPERTY_TYPES.map((t) => t.value as string);
    const cases: [string | null, boolean][] = [
      ["multi_family", true],
      ["multi_family", false],
      ["condo", true],
      ["townhouse", true],
      [null, true],
      [null, false],
    ];
    for (const [factsType, hasUnit] of cases) {
      expect(allowed).toContain(defaultPropertyType(factsType, hasUnit));
    }
  });
});
