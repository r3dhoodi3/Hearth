import { describe, it, expect } from "vitest";
import { normalizeEmail, isDisposableDomain } from "./emailNorm";

// normalizeEmail decides whether two signups are the same person. Getting it
// wrong in one direction hands a farmer a free variant; getting it wrong in the
// other accuses two unrelated people of being one, so both directions are
// pinned here.

describe("normalizeEmail: gmail", () => {
  it("strips dots from the local part", () => {
    expect(normalizeEmail("s.a.m@gmail.com")?.normalized).toBe("sam@gmail.com");
  });

  it("strips a plus tag", () => {
    expect(normalizeEmail("sam+hearth@gmail.com")?.normalized).toBe("sam@gmail.com");
  });

  it("strips both, in either order", () => {
    expect(normalizeEmail("s.am+trial2@gmail.com")?.normalized).toBe("sam@gmail.com");
    expect(normalizeEmail("sam+tr.ial@gmail.com")?.normalized).toBe("sam@gmail.com");
  });

  it("folds googlemail.com into gmail.com", () => {
    expect(normalizeEmail("s.am@googlemail.com")?.normalized).toBe("sam@gmail.com");
    expect(normalizeEmail("sam@googlemail.com")?.domain).toBe("gmail.com");
  });

  it("lowercases", () => {
    expect(normalizeEmail("  SaM@GMail.COM ")?.normalized).toBe("sam@gmail.com");
  });

  it("collapses four farming variants onto one address", () => {
    const variants = [
      "sam@gmail.com",
      "s.am@gmail.com",
      "sam+1@gmail.com",
      "S.A.M+hearth@googlemail.com",
    ].map((e) => normalizeEmail(e)?.normalized);
    expect(new Set(variants).size).toBe(1);
  });
});

describe("normalizeEmail: every other domain", () => {
  it("strips the plus tag", () => {
    expect(normalizeEmail("sam+hearth@outlook.com")?.normalized).toBe(
      "sam@outlook.com"
    );
  });

  it("KEEPS dots, because they are a different mailbox there", () => {
    // sam.smith@ and samsmith@ really are two different people at outlook.
    expect(normalizeEmail("sam.smith@outlook.com")?.normalized).toBe(
      "sam.smith@outlook.com"
    );
    expect(normalizeEmail("sam.smith@outlook.com")?.normalized).not.toBe(
      normalizeEmail("samsmith@outlook.com")?.normalized
    );
  });
});

describe("normalizeEmail: rejects what is not an address", () => {
  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["notanemail"],
    ["@gmail.com"],
    ["sam@"],
    ["sam@localhost"],
    ["sam smith@gmail.com"],
    ["+tag@gmail.com"],
    ["...@gmail.com"],
  ])("returns null for %p", (input) => {
    expect(normalizeEmail(input as string | null | undefined)).toBeNull();
  });

  it("splits on the LAST @, not the first", () => {
    expect(normalizeEmail('"odd@name"@example.com')?.domain).toBe("example.com");
  });
});

describe("isDisposableDomain", () => {
  it("flags the throwaway providers", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("YOPMAIL.com")).toBe(true);
    expect(isDisposableDomain("10minutemail.com")).toBe(true);
  });

  it("flags their unlimited subdomains", () => {
    expect(isDisposableDomain("anything.mailinator.com")).toBe(true);
    expect(isDisposableDomain("abc.yopmail.com")).toBe(true);
  });

  it("does NOT flag the providers real customers use", () => {
    for (const d of [
      "gmail.com",
      "outlook.com",
      "yahoo.com",
      "icloud.com",
      "proton.me",
      "fastmail.com",
      "hey.com",
      "ramirezplumbing.com",
    ]) {
      expect(isDisposableDomain(d)).toBe(false);
    }
  });

  it("rides along on the normalized result", () => {
    expect(normalizeEmail("throwaway@mailinator.com")?.disposable).toBe(true);
    expect(normalizeEmail("sam@gmail.com")?.disposable).toBe(false);
  });
});
