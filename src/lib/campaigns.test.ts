import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_CODE_RE,
  CAMPAIGN_CODES,
  UNKNOWN_CAMPAIGN_CODE,
  isWellFormedCampaignCode,
  lookupCampaign,
} from "./campaigns";

describe("CAMPAIGN_CODE_RE / isWellFormedCampaignCode", () => {
  it("accepts lowercase letters, digits and hyphens, 2 to 32 chars", () => {
    expect(isWellFormedCampaignCode("ig-d01")).toBe(true);
    expect(isWellFormedCampaignCode("tt-d14")).toBe(true);
    expect(isWellFormedCampaignCode("ab")).toBe(true);
    expect(isWellFormedCampaignCode("a".repeat(32))).toBe(true);
  });

  it("rejects anything too short, too long, or outside the charset", () => {
    expect(isWellFormedCampaignCode("a")).toBe(false); // too short
    expect(isWellFormedCampaignCode("a".repeat(33))).toBe(false); // too long
    expect(isWellFormedCampaignCode("")).toBe(false);
    expect(isWellFormedCampaignCode("IG-D01")).toBe(false); // uppercase
    expect(isWellFormedCampaignCode("ig_d01")).toBe(false); // underscore
    expect(isWellFormedCampaignCode("ig.d01")).toBe(false); // dot
    expect(isWellFormedCampaignCode("ig/d01")).toBe(false); // slash
    expect(isWellFormedCampaignCode("ig d01")).toBe(false); // space
    expect(isWellFormedCampaignCode("<script>")).toBe(false); // injection attempt
  });

  it("the exported regex agrees with the helper", () => {
    expect(CAMPAIGN_CODE_RE.test("ig-d01")).toBe(true);
    expect(CAMPAIGN_CODE_RE.test("IG-D01")).toBe(false);
  });
});

describe("CAMPAIGN_CODES (the calendar allowlist)", () => {
  it("has exactly the 28 codes the calendar uses: ig-d01..d14 and tt-d01..d14", () => {
    const keys = Object.keys(CAMPAIGN_CODES).sort();
    const expected: string[] = [];
    for (const prefix of ["ig", "tt"]) {
      for (let day = 1; day <= 14; day++) {
        expected.push(`${prefix}-d${String(day).padStart(2, "0")}`);
      }
    }
    expect(keys).toEqual(expected.sort());
    expect(keys).toHaveLength(28);
  });

  it("every code is well-formed by the route's own gate", () => {
    for (const code of Object.keys(CAMPAIGN_CODES)) {
      expect(isWellFormedCampaignCode(code)).toBe(true);
    }
  });

  it("tags ig- codes instagram and tt- codes tiktok", () => {
    expect(CAMPAIGN_CODES["ig-d01"].channel).toBe("instagram");
    expect(CAMPAIGN_CODES["tt-d01"].channel).toBe("tiktok");
  });

  it("sends the pro days (3, 8, 13) to /pros and every other day to /", () => {
    for (const prefix of ["ig", "tt"]) {
      expect(CAMPAIGN_CODES[`${prefix}-d03`].destination).toBe("/pros");
      expect(CAMPAIGN_CODES[`${prefix}-d08`].destination).toBe("/pros");
      expect(CAMPAIGN_CODES[`${prefix}-d13`].destination).toBe("/pros");
      for (const day of [1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 14]) {
        const code = `${prefix}-d${String(day).padStart(2, "0")}`;
        expect(CAMPAIGN_CODES[code].destination).toBe("/");
      }
    }
  });
});

describe("lookupCampaign", () => {
  it("returns the link for a real, well-formed code", () => {
    const link = lookupCampaign("ig-d02");
    expect(link).not.toBeNull();
    expect(link?.destination).toBe("/");
    expect(link?.channel).toBe("instagram");
  });

  it("returns null for a well-formed code that just isn't on the list", () => {
    // Same shape as a real code, but not one of the 28 the calendar uses -
    // this is the case the route logs as UNKNOWN_CAMPAIGN_CODE rather than
    // as itself.
    expect(lookupCampaign("ig-d99")).toBeNull();
    expect(lookupCampaign("random-code")).toBeNull();
  });

  it("returns null for a malformed code without ever indexing into the map", () => {
    expect(lookupCampaign("IG-D01")).toBeNull();
    expect(lookupCampaign("a")).toBeNull();
    expect(lookupCampaign("<script>alert(1)</script>")).toBeNull();
    expect(lookupCampaign("../../etc/passwd")).toBeNull();
  });

  it("UNKNOWN_CAMPAIGN_CODE is a fixed literal, not derived from input", () => {
    expect(UNKNOWN_CAMPAIGN_CODE).toBe("unknown_code");
    // Deliberately outside CAMPAIGN_CODE_RE's charset (the underscore): this
    // value is only ever assigned directly into props.code by the route, never
    // run back through the validator, so there's no risk of it round-tripping
    // as if it were a real path segment.
    expect(isWellFormedCampaignCode(UNKNOWN_CAMPAIGN_CODE)).toBe(false);
  });
});
