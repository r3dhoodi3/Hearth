import { describe, expect, it } from "vitest";
import {
  boundedInt,
  boundedNumber,
  cappedField,
  cappedFieldOrNull,
  FIELD_MAX,
  HONEYPOT_FIELD,
  honeypotTripped,
  isAllowedValue,
} from "@/lib/formFields";
import {
  ISSUE_CATEGORIES,
  JOB_CATEGORIES,
  SEVERITIES,
  SYSTEM_TYPES,
} from "@/lib/constants";

function fd(entries: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(entries)) form.set(k, v);
  return form;
}

describe("cappedField", () => {
  it("trims and returns the value", () => {
    expect(cappedField(fd({ name: "  Ada Lovelace  " }), "name", 200)).toBe(
      "Ada Lovelace"
    );
  });

  it("truncates rather than rejecting", () => {
    const long = "x".repeat(500);
    expect(cappedField(fd({ note: long }), "note", 10)).toBe("x".repeat(10));
  });

  it("trims before slicing, so padding never eats the cap", () => {
    expect(cappedField(fd({ note: "   abcdef" }), "note", 3)).toBe("abc");
  });

  it("returns an empty string for a missing field", () => {
    expect(cappedField(fd({}), "nope", 10)).toBe("");
  });

  it("returns an empty string for whitespace only", () => {
    expect(cappedField(fd({ name: "   " }), "name", 10)).toBe("");
  });
});

describe("cappedFieldOrNull", () => {
  it("turns empty into null", () => {
    expect(cappedFieldOrNull(fd({ phone: "  " }), "phone", 40)).toBeNull();
    expect(cappedFieldOrNull(fd({}), "phone", 40)).toBeNull();
  });

  it("keeps a real value, capped", () => {
    expect(cappedFieldOrNull(fd({ phone: " 555-1234 " }), "phone", 40)).toBe(
      "555-1234"
    );
    expect(cappedFieldOrNull(fd({ phone: "1".repeat(80) }), "phone", 40)).toBe(
      "1".repeat(40)
    );
  });
});

describe("boundedNumber", () => {
  it("accepts a number inside the range", () => {
    expect(boundedNumber("1998", 1900, 2100)).toBe(1998);
    expect(boundedNumber(" 3.5 ", 1, 5)).toBe(3.5);
  });

  it("accepts the bounds themselves", () => {
    expect(boundedNumber("1900", 1900, 2100)).toBe(1900);
    expect(boundedNumber("2100", 1900, 2100)).toBe(2100);
  });

  it("rejects values outside the range", () => {
    expect(boundedNumber("1899", 1900, 2100)).toBeNull();
    expect(boundedNumber("999999", 1900, 2100)).toBeNull();
    expect(boundedNumber("-1", 0, 5)).toBeNull();
  });

  // The whole point of the Number.isFinite guard: these all became NaN under
  // the old `v ? Number(v) : null` shape and sailed into the database.
  it("rejects anything that isn't a finite number", () => {
    expect(boundedNumber("abc", 0, 100)).toBeNull();
    expect(boundedNumber("12abc", 0, 100)).toBeNull();
    expect(boundedNumber("NaN", 0, 100)).toBeNull();
    expect(boundedNumber("Infinity", 0, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(boundedNumber("1e400", 0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("treats blank and missing as null, not zero", () => {
    expect(boundedNumber("", 0, 100)).toBeNull();
    expect(boundedNumber("   ", 0, 100)).toBeNull();
    expect(boundedNumber(null, 0, 100)).toBeNull();
    expect(boundedNumber(undefined, 0, 100)).toBeNull();
  });

  it("keeps a real zero when zero is in range", () => {
    expect(boundedNumber("0", 0, 100)).toBe(0);
  });

  it("supports negative ranges (latitude, longitude)", () => {
    expect(boundedNumber("-117.9", -180, 180)).toBe(-117.9);
    expect(boundedNumber("-181", -180, 180)).toBeNull();
  });
});

describe("boundedInt", () => {
  it("truncates toward zero after the range check", () => {
    expect(boundedInt("1998.7", 1900, 2100)).toBe(1998);
    expect(boundedInt("4.9", 1, 5)).toBe(4);
  });

  it("applies the range to the value as typed, not the truncated one", () => {
    // 5.4 is out of a 1-5 range, so it is dropped rather than becoming 5.
    expect(boundedInt("5.4", 1, 5)).toBeNull();
  });

  it("rejects junk the same way boundedNumber does", () => {
    expect(boundedInt("abc", 1, 5)).toBeNull();
    expect(boundedInt("", 1, 5)).toBeNull();
  });
});

describe("isAllowedValue", () => {
  it("accepts every value the shared lists actually offer", () => {
    for (const c of ISSUE_CATEGORIES) {
      expect(isAllowedValue(ISSUE_CATEGORIES, c.value)).toBe(true);
    }
    for (const s of SEVERITIES) {
      expect(isAllowedValue(SEVERITIES, s.value)).toBe(true);
    }
    for (const s of SYSTEM_TYPES) {
      expect(isAllowedValue(SYSTEM_TYPES, s.value)).toBe(true);
    }
    for (const j of JOB_CATEGORIES) {
      expect(isAllowedValue(JOB_CATEGORIES, j.value)).toBe(true);
    }
  });

  it("rejects a value from a different list", () => {
    // "remodeling" is a job category but not a home-problem category, and
    // "water_heater" is a system type but not a job category.
    expect(isAllowedValue(ISSUE_CATEGORIES, "remodeling")).toBe(false);
    expect(isAllowedValue(JOB_CATEGORIES, "water_heater")).toBe(false);
  });

  it("rejects forged, blank, and missing values", () => {
    expect(isAllowedValue(JOB_CATEGORIES, "free_money")).toBe(false);
    expect(isAllowedValue(SEVERITIES, "URGENT")).toBe(false);
    expect(isAllowedValue(SEVERITIES, "")).toBe(false);
    expect(isAllowedValue(SEVERITIES, null)).toBe(false);
    expect(isAllowedValue(SEVERITIES, undefined)).toBe(false);
  });

  it("does not match on a prototype property name", () => {
    expect(isAllowedValue(JOB_CATEGORIES, "constructor")).toBe(false);
    expect(isAllowedValue(JOB_CATEGORIES, "toString")).toBe(false);
  });
});

describe("FIELD_MAX", () => {
  it("keeps email at the longest address the standard allows", () => {
    expect(FIELD_MAX.email).toBe(254);
  });
});

describe("honeypotTripped", () => {
  function pot(value?: string): FormData {
    const f = new FormData();
    if (value !== undefined) f.set(HONEYPOT_FIELD, value);
    return f;
  }

  it("is quiet for a real sender: missing, empty, or whitespace-only", () => {
    // A browser submits the field as "" on every genuine send, and some
    // password managers drop a space in. Neither may be treated as a bot, or
    // every real message is silently binned.
    expect(honeypotTripped(pot())).toBe(false);
    expect(honeypotTripped(pot(""))).toBe(false);
    expect(honeypotTripped(pot("   "))).toBe(false);
  });

  it("trips on anything a script actually typed", () => {
    expect(honeypotTripped(pot("https://spam.example"))).toBe(true);
    expect(honeypotTripped(pot(" x "))).toBe(true);
  });

  it("names the same field the three forms render", () => {
    // src/components/Honeypot.tsx renders this name; /contact,
    // /account/help and /pro/help all read it through this helper.
    expect(HONEYPOT_FIELD).toBe("company_website");
  });
});
