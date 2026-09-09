import { describe, it, expect } from "vitest";
import {
  normalizeContactEmail,
  normalizeContactPhone,
  MAX_CONTACT_EMAIL_LEN,
} from "./contactFields";

describe("normalizeContactEmail", () => {
  it("keeps a normal address, trimmed", () => {
    expect(normalizeContactEmail("  owner@example.com ")).toBe(
      "owner@example.com"
    );
    expect(normalizeContactEmail("first.last+tag@sub.example.co.uk")).toBe(
      "first.last+tag@sub.example.co.uk"
    );
  });

  it("rejects junk that used to reach the database", () => {
    expect(normalizeContactEmail("asdf")).toBeNull();
    expect(normalizeContactEmail("owner@example")).toBeNull();
    expect(normalizeContactEmail("owner @example.com")).toBeNull();
    expect(normalizeContactEmail("@example.com")).toBeNull();
    expect(normalizeContactEmail("a@b@example.com")).toBeNull();
  });

  it("rejects blank, non-string, and oversized values", () => {
    expect(normalizeContactEmail("")).toBeNull();
    expect(normalizeContactEmail("   ")).toBeNull();
    expect(normalizeContactEmail(null)).toBeNull();
    expect(normalizeContactEmail(42)).toBeNull();
    const long = `${"a".repeat(MAX_CONTACT_EMAIL_LEN)}@example.com`;
    expect(normalizeContactEmail(long)).toBeNull();
  });
});

describe("normalizeContactPhone", () => {
  it("keeps what PhoneInput produces", () => {
    expect(normalizeContactPhone("(714) 555-0100")).toBe("(714) 555-0100");
    expect(normalizeContactPhone(" 714-555-0100 ")).toBe("714-555-0100");
    expect(normalizeContactPhone("+1 714 555 0100")).toBe("+1 714 555 0100");
  });

  it("rejects a half-typed number", () => {
    expect(normalizeContactPhone("(714) 555-01")).toBeNull();
    expect(normalizeContactPhone("555")).toBeNull();
  });

  it("rejects letters, markup, and oversized values", () => {
    expect(normalizeContactPhone("call me")).toBeNull();
    expect(normalizeContactPhone("<b>7145550100</b>")).toBeNull();
    expect(normalizeContactPhone("7145550100 ext 12345")).toBeNull();
    expect(normalizeContactPhone("1".repeat(26))).toBeNull();
    expect(normalizeContactPhone("")).toBeNull();
    expect(normalizeContactPhone(undefined)).toBeNull();
  });
});
