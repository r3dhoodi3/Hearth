import { describe, expect, it } from "vitest";
import { formatAddressLine } from "./addressLine";

// This is the whole seam between "what the database stores" and "what a person
// reads". address_line1 must stay the bare street line - the parcel lookup,
// the parcel cache key, and the assessor ownership match all run against it -
// so the unit only ever appears by way of this function.
describe("formatAddressLine", () => {
  it("returns the street alone when there is no unit", () => {
    expect(formatAddressLine({ address_line1: "742 Evergreen Terrace" })).toBe(
      "742 Evergreen Terrace"
    );
    expect(
      formatAddressLine({ address_line1: "742 Evergreen Terrace", unit: null })
    ).toBe("742 Evergreen Terrace");
    // A row from a database that has not run migration 0127 has no unit key
    // at all, which has to behave exactly like an explicit null.
    expect(
      formatAddressLine({ address_line1: "742 Evergreen Terrace" } as {
        address_line1: string;
        unit?: string | null;
      })
    ).toBe("742 Evergreen Terrace");
  });

  it("labels a bare identifier as a unit", () => {
    expect(
      formatAddressLine({ address_line1: "123 Main St", unit: "4B" })
    ).toBe("123 Main St, Unit 4B");
    expect(formatAddressLine({ address_line1: "123 Main St", unit: "4" })).toBe(
      "123 Main St, Unit 4"
    );
  });

  it("leaves a designator the owner typed themselves alone", () => {
    // "Apt 2" must never become "Unit Apt 2".
    expect(
      formatAddressLine({ address_line1: "123 Main St", unit: "Apt 2" })
    ).toBe("123 Main St, Apt 2");
    expect(
      formatAddressLine({ address_line1: "123 Main St", unit: "#12" })
    ).toBe("123 Main St, #12");
    expect(
      formatAddressLine({ address_line1: "9 Harbor Way", unit: "Ste 300" })
    ).toBe("9 Harbor Way, Ste 300");
    // Case doesn't matter, and neither does an already-spelled-out "Unit".
    expect(
      formatAddressLine({ address_line1: "9 Harbor Way", unit: "unit 3" })
    ).toBe("9 Harbor Way, unit 3");
  });

  it("is not fooled by a unit that merely starts with designator letters", () => {
    // "Unit" is a word boundary, not a prefix match: a unit literally called
    // "Unity" (or "Aptos", "Suites") is a bare identifier.
    expect(
      formatAddressLine({ address_line1: "1 Elm Ct", unit: "Unity" })
    ).toBe("1 Elm Ct, Unit Unity");
  });

  it("trims, and treats whitespace as no unit at all", () => {
    expect(
      formatAddressLine({ address_line1: "  123 Main St  ", unit: "  4B " })
    ).toBe("123 Main St, Unit 4B");
    expect(
      formatAddressLine({ address_line1: "123 Main St", unit: "   " })
    ).toBe("123 Main St");
    expect(formatAddressLine({ address_line1: "123 Main St", unit: "" })).toBe(
      "123 Main St"
    );
  });

  it("never emits a dangling comma when the street is missing", () => {
    // Should not happen (address_line1 is NOT NULL and length-checked at
    // claim time), but a leading ", Unit 4B" would be worse than useless.
    expect(formatAddressLine({ address_line1: "", unit: "4B" })).toBe("4B");
    expect(formatAddressLine({ address_line1: "", unit: "" })).toBe("");
  });
});
