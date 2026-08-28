import { describe, expect, it } from "vitest";
import {
  isValidLicenseNumber,
  licenseDigits,
  licenseNameMatches,
  normalizeBusinessName,
} from "./licenseMatch";

// The identity half of CSLB verification. Two directions matter here and they
// pull against each other: a pro must not be able to verify on a stranger's
// license (the false-accept cases at the bottom), and a real pro must not be
// locked out because CSLB spells their name differently than Hearth does (the
// long list of shape differences above it). This matcher deliberately errs
// toward accepting - the hard guarantee is the one-license-one-account lock
// (migration 0125), not this comparison.
describe("normalizeBusinessName", () => {
  it("uppercases and drops punctuation", () => {
    expect(normalizeBusinessName("Bob's Plumbing, Inc.")).toEqual([
      "BOB",
      "PLUMBING",
    ]);
  });

  it("drops corporate stopwords and standalone single letters", () => {
    expect(normalizeBusinessName("The A & B Company of Anaheim")).toEqual([
      "ANAHEIM",
    ]);
  });

  it("decodes HTML entities scraped off the CSLB page", () => {
    expect(normalizeBusinessName("SMITH &amp; SONS")).toEqual([
      "SMITH",
      "SONS",
    ]);
  });

  it("returns nothing for empty or meaningless input", () => {
    expect(normalizeBusinessName("")).toEqual([]);
    expect(normalizeBusinessName("   ")).toEqual([]);
    expect(normalizeBusinessName("!!! --- ###")).toEqual([]);
    expect(normalizeBusinessName("INC LLC CORP")).toEqual([]);
  });
});

describe("licenseNameMatches", () => {
  it("matches an exact name", () => {
    expect(
      licenseNameMatches("ACME PLUMBING", ["Acme Plumbing"])
    ).toBe(true);
  });

  it("ignores INC / LLC / CORP suffix differences", () => {
    expect(
      licenseNameMatches("ACME PLUMBING INC", ["Acme Plumbing, LLC"])
    ).toBe(true);
    expect(
      licenseNameMatches("ACME PLUMBING CORPORATION", ["ACME PLUMBING CO"])
    ).toBe(true);
  });

  it("matches a surname-first sole proprietor record against a personal name", () => {
    // CSLB stores sole proprietors "LASTNAME FIRSTNAME"; the account says
    // "John Doe". Order-independent token overlap is the whole point.
    expect(licenseNameMatches("DOE JOHN", ["John Doe"])).toBe(true);
    expect(licenseNameMatches("DOE JOHN M", [null, "John Doe"])).toBe(true);
  });

  it("matches through a dba line", () => {
    expect(
      licenseNameMatches("L B POWERS AND SON PLUMBING CO INC dba POWERS PLUMBING", [
        "Powers Plumbing",
      ])
    ).toBe(true);
  });

  it("matches when only the account holder's personal name lines up", () => {
    expect(
      licenseNameMatches("NGUYEN TRANG", ["Sunrise Roofing", "Trang Nguyen"])
    ).toBe(true);
  });

  it("matches a trade name that extends the registered name", () => {
    expect(
      licenseNameMatches("MENDOZA CONSTRUCTION", [
        "Mendoza Construction and Remodeling",
      ])
    ).toBe(true);
  });

  it("rejects clearly different companies", () => {
    expect(
      licenseNameMatches("ACME PLUMBING INC", ["Bob's Electrical Service LLC"])
    ).toBe(false);
    expect(licenseNameMatches("DOE JOHN", ["Maria Sanchez"])).toBe(false);
  });

  it("does not count a shared generic trade word as identity", () => {
    // Half the licenses in the state say PLUMBING or CONSTRUCTION somewhere.
    // Sharing only that word is not evidence the license belongs to this
    // account.
    expect(
      licenseNameMatches("SMITH PLUMBING INC", ["Acme Plumbing"])
    ).toBe(false);
    expect(
      licenseNameMatches("PACIFIC COAST CONSTRUCTION", ["Valley Construction LLC"])
    ).toBe(false);
  });

  it("rejects short substrings that are not whole-token runs", () => {
    // A raw substring test once let these through; containment must land on
    // token boundaries and single words never match by containment at all.
    expect(licenseNameMatches("MENDOZA CONSTRUCTION", ["Ndo"])).toBe(false);
    expect(licenseNameMatches("JONES ROBERT", ["Jo"])).toBe(false);
    expect(licenseNameMatches("ANDERSON ELECTRIC", ["Son"])).toBe(false);
    expect(licenseNameMatches("ABC REPAIR INC", ["Air"])).toBe(false);
    expect(licenseNameMatches("PALACE BUILDERS", ["Ace"])).toBe(false);
  });

  it("still matches a business named only in generic words, via containment", () => {
    // Trade words are excluded as single-word evidence but NOT stripped from
    // the normalized string, so an all-generic name matches its own record.
    expect(
      licenseNameMatches("HOME REPAIR SERVICES INC", ["Home Repair Services"])
    ).toBe(true);
  });

  it("rejects empty, garbage, or nameless input", () => {
    expect(licenseNameMatches("", ["Acme Plumbing"])).toBe(false);
    expect(licenseNameMatches("INC", ["Acme Plumbing"])).toBe(false);
    expect(licenseNameMatches("ACME PLUMBING", [])).toBe(false);
    expect(licenseNameMatches("ACME PLUMBING", [null, undefined, "", "   "])).toBe(
      false
    );
    expect(licenseNameMatches("!!!", ["!!!"])).toBe(false);
  });
});

describe("licenseDigits", () => {
  it("collapses every spelling of a license number to its digits", () => {
    expect(licenseDigits("LIC# 270663")).toBe("270663");
    expect(licenseDigits("270-663")).toBe("270663");
    expect(licenseDigits("270663")).toBe("270663");
  });

  it("is empty for nothing checkable", () => {
    expect(licenseDigits(null)).toBe("");
    expect(licenseDigits(undefined)).toBe("");
    expect(licenseDigits("no digits here")).toBe("");
  });
});

describe("isValidLicenseNumber", () => {
  it("accepts real CSLB-shaped numbers, 5 to 8 plain digits", () => {
    expect(isValidLicenseNumber("1029384")).toBe(true);
    expect(isValidLicenseNumber("12345")).toBe(true);
    expect(isValidLicenseNumber("12345678")).toBe(true);
  });

  it("strips spaces before checking length", () => {
    expect(isValidLicenseNumber("1029 384")).toBe(true);
    expect(isValidLicenseNumber(" 270663 ")).toBe(true);
  });

  it("rejects too short, too long, or non-digit input", () => {
    expect(isValidLicenseNumber("1234")).toBe(false);
    expect(isValidLicenseNumber("123456789")).toBe(false);
    expect(isValidLicenseNumber("LIC-000000-XX")).toBe(false);
    expect(isValidLicenseNumber("270-663")).toBe(false);
  });

  it("rejects nothing to check", () => {
    expect(isValidLicenseNumber(null)).toBe(false);
    expect(isValidLicenseNumber(undefined)).toBe(false);
    expect(isValidLicenseNumber("")).toBe(false);
  });
});
