import { describe, it, expect } from "vitest";
import { sanitizeTrackProps, MAX_KEYS, MAX_STRING } from "./trackProps";

describe("sanitizeTrackProps", () => {
  it("keeps ids, enums, route patterns, numbers and booleans", () => {
    expect(
      sanitizeTrackProps({
        metric: "LCP",
        value: 1234.5678,
        rating: "good",
        path: "/pro/crm/:id",
        sample_rate: 0.1,
        cleared: true,
        lead: "8f1c2d3e-0000-4000-8000-000000000000",
      })
    ).toEqual({
      metric: "LCP",
      value: 1234.568,
      rating: "good",
      path: "/pro/crm/:id",
      sample_rate: 0.1,
      cleared: true,
      lead: "8f1c2d3e-0000-4000-8000-000000000000",
    });
  });

  it("drops free text, emails, urls with query strings, and nested values", () => {
    expect(
      sanitizeTrackProps({
        note: "call me at 555 0100",
        email: "someone@example.com",
        url: "https://x.test/?token=abc",
        nested: { a: 1 },
        list: [1, 2],
        nothing: null,
        ok: "quote",
      })
    ).toEqual({ ok: "quote" });
  });

  it("drops bad keys, non-finite numbers and over-long strings", () => {
    expect(
      sanitizeTrackProps({
        "Bad Key": "x",
        __proto__x: "y",
        n: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        long: "a".repeat(MAX_STRING + 1),
        fine: "a".repeat(MAX_STRING),
      })
    ).toEqual({ fine: "a".repeat(MAX_STRING) });
  });

  it("caps the key count and returns null when nothing survives", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_KEYS + 5; i++) many[`k${i}`] = i;
    expect(Object.keys(sanitizeTrackProps(many) ?? {})).toHaveLength(MAX_KEYS);
    expect(sanitizeTrackProps({ text: "hello world" })).toBeNull();
    expect(sanitizeTrackProps("string")).toBeNull();
    expect(sanitizeTrackProps([1])).toBeNull();
    expect(sanitizeTrackProps(null)).toBeNull();
  });
});
