import { describe, expect, it } from "vitest";
import {
  houseNumberOf,
  matchesAnyStreetName,
  streetNameCoreOf,
  sameStreetAddress,
  streetTokensOf,
} from "./addressMatch";

// The address a real tester picked from the autocomplete list, and the one the
// records lookup came back with and silently swapped in.
const PICKED = "1770 South Harbor Boulevard";
const RECORD = "2170 S Harbor Blvd";

describe("houseNumberOf", () => {
  it("reads the leading number", () => {
    expect(houseNumberOf(PICKED)).toBe("1770");
    expect(houseNumberOf(RECORD)).toBe("2170");
  });

  it("keeps a hyphenated or suffixed number whole", () => {
    expect(houseNumberOf("12-14 Main St")).toBe("12-14");
    expect(houseNumberOf("221b Baker St")).toBe("221b");
  });

  it("is null for a line that does not start with a number", () => {
    expect(houseNumberOf("Harbor Blvd")).toBeNull();
    expect(houseNumberOf("")).toBeNull();
  });
});

describe("streetTokensOf", () => {
  it("normalizes directionals and street types to one spelling", () => {
    expect(streetTokensOf(PICKED)).toEqual(["s", "harbor", "blvd"]);
    expect(streetTokensOf(RECORD)).toEqual(["s", "harbor", "blvd"]);
  });

  it("drops the unit designator and everything after it", () => {
    expect(streetTokensOf("1770 S Harbor Blvd Unit 204")).toEqual([
      "s",
      "harbor",
      "blvd",
    ]);
    expect(streetTokensOf("1770 S Harbor Blvd #204")).toEqual([
      "s",
      "harbor",
      "blvd",
    ]);
    expect(streetTokensOf("1770 S Harbor Blvd, Apt 4B")).toEqual([
      "s",
      "harbor",
      "blvd",
    ]);
  });
});

describe("sameStreetAddress", () => {
  it("is false for the tester's mismatch", () => {
    expect(sameStreetAddress(PICKED, RECORD)).toBe(false);
  });

  it("is true across spelling, case and punctuation differences", () => {
    expect(sameStreetAddress(PICKED, "1770 S Harbor Blvd")).toBe(true);
    expect(sameStreetAddress("1770 s. harbor blvd.", PICKED)).toBe(true);
    expect(
      sameStreetAddress("123 West Oak Street", "123 W Oak St")
    ).toBe(true);
  });

  it("ignores the unit on either side", () => {
    expect(sameStreetAddress(PICKED, "1770 S Harbor Blvd Unit 204")).toBe(true);
    expect(sameStreetAddress("1770 S Harbor Blvd #204", "1770 S Harbor Blvd")).toBe(
      true
    );
  });

  it("is false when only the street differs", () => {
    expect(sameStreetAddress("1770 S Harbor Blvd", "1770 S Harbor Way")).toBe(
      false
    );
    expect(sameStreetAddress("1770 S Harbor Blvd", "1770 N Harbor Blvd")).toBe(
      false
    );
  });

  it("is false when one side has no house number and the other does", () => {
    expect(sameStreetAddress("Harbor Blvd", "1770 Harbor Blvd")).toBe(false);
  });

  it("compares street tokens alone when neither side is numbered", () => {
    expect(sameStreetAddress("Harbor Boulevard", "Harbor Blvd")).toBe(true);
  });

  it("is false when there is nothing to compare", () => {
    expect(sameStreetAddress("", "")).toBe(false);
    expect(sameStreetAddress("1770", "1770")).toBe(false);
  });
});


describe("streetNameCoreOf", () => {
  it("drops the house number, the unit and the trailing street type", () => {
    expect(streetNameCoreOf("16781 Bolsa Chica St")).toEqual(["bolsa", "chica"]);
    expect(streetNameCoreOf("1770 S Harbor Blvd Unit 204")).toEqual([
      "s",
      "harbor",
    ]);
  });

  it("reduces different street types on the same name to the same core", () => {
    // The measured case: Photon answers "16781 Bolsa Chica St" with Bolsa
    // Chica ROAD. It plainly knows the place.
    expect(streetNameCoreOf("Bolsa Chica Road")).toEqual(["bolsa", "chica"]);
    expect(streetNameCoreOf("Bolsa Chica Street")).toEqual(["bolsa", "chica"]);
  });

  it("keeps directionals, which distinguish real streets", () => {
    expect(streetNameCoreOf("1770 N Harbor Blvd")).toEqual(["n", "harbor"]);
    expect(streetNameCoreOf("1770 S Harbor Blvd")).toEqual(["s", "harbor"]);
  });

  it("keeps a lone token that happens to be a street type", () => {
    // "Broadway" is a name, not a type, and a one-token core must survive:
    // stripping it would leave nothing to compare and refuse the address.
    expect(streetNameCoreOf("100 Broadway")).toEqual(["broadway"]);
    expect(streetNameCoreOf("Way")).toEqual(["way"]);
  });
});

describe("matchesAnyStreetName", () => {
  // Real Photon output, trimmed: what the geocoder actually returned for
  // "123 Fake Street, California" on 2026-08-28. Fifteen results, every one a
  // genuine street, not one of them the street typed.
  const FAKE_STREET_RESULTS = [
    "North Sunkist Street",
    "South Kingsley Street",
    "South Kroeger Street",
    "South La Paz Street",
  ];

  it("is false when the geocoder named no such street", () => {
    expect(matchesAnyStreetName("123 Fake Street", FAKE_STREET_RESULTS)).toBe(
      false
    );
  });

  it("is true when one candidate names the same street", () => {
    expect(
      matchesAnyStreetName("1920 Main Street", ["Magnolia Avenue", "Main Street"])
    ).toBe(true);
  });

  // The four live false refusals that killed the exact-address version of this
  // check. Each is a real Orange County address whose house number OSM has
  // never mapped, and each must pass.
  it.each([
    ["16781 Bolsa Chica St", ["Bolsa Chica Road", "Bolsa Chica State Beach"]],
    ["1234 W Chapman Ave", ["West Chapman Avenue", "East Chapman Avenue"]],
    ["1 Hotel Terrace", ["Hotel Terrace", "South Grand Avenue"]],
    ["10 Civic Center Plaza", ["Civic Center Plaza"]],
  ])("passes %s on a street the geocoder knows", (line, candidates) => {
    expect(matchesAnyStreetName(line, candidates)).toBe(true);
  });

  it("normalizes both sides, so spelled-out and abbreviated agree", () => {
    expect(
      matchesAnyStreetName("1770 S Harbor Blvd", ["South Harbor Boulevard"])
    ).toBe(true);
  });

  it("still tells North Harbor from South Harbor", () => {
    expect(
      matchesAnyStreetName("1770 S Harbor Blvd", ["North Harbor Boulevard"])
    ).toBe(false);
  });

  it("is false against an empty candidate list", () => {
    expect(matchesAnyStreetName("1920 Main Street", [])).toBe(false);
  });

  it("is false when the typed line has no street part to compare", () => {
    expect(matchesAnyStreetName("1920", ["Main Street"])).toBe(false);
  });
});
