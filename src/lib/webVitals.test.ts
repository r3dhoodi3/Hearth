import { describe, expect, it } from "vitest";
import {
  buildWebVitalsProps,
  isWebVitalName,
  normalizeRoutePattern,
  roundMetricValue,
  shouldSampleWebVitals,
  WEB_VITALS_SAMPLE_RATE,
} from "./webVitals";

// Pins the two things WebVitals.tsx relies on the library-free helpers to
// get right: only a real Core Web Vital name is ever reported (a typo or a
// future metric the route hasn't been taught yet must be dropped, not
// forwarded), and every path is a route PATTERN, never a raw id or query
// string - the payload rule in docs/ANALYTICS.md.

describe("shouldSampleWebVitals", () => {
  it("samples at the fixed rate, not per-call randomness", () => {
    expect(shouldSampleWebVitals(() => 0)).toBe(true);
    expect(shouldSampleWebVitals(() => WEB_VITALS_SAMPLE_RATE - 0.001)).toBe(true);
    expect(shouldSampleWebVitals(() => WEB_VITALS_SAMPLE_RATE)).toBe(false);
    expect(shouldSampleWebVitals(() => 0.999)).toBe(false);
  });
});

describe("isWebVitalName", () => {
  it("accepts only the four reported metrics", () => {
    expect(isWebVitalName("LCP")).toBe(true);
    expect(isWebVitalName("INP")).toBe(true);
    expect(isWebVitalName("CLS")).toBe(true);
    expect(isWebVitalName("TTFB")).toBe(true);
  });

  it("rejects a metric this route was never taught, e.g. FCP or FID", () => {
    expect(isWebVitalName("FCP")).toBe(false);
    expect(isWebVitalName("FID")).toBe(false);
    expect(isWebVitalName("")).toBe(false);
  });
});

describe("normalizeRoutePattern", () => {
  it("leaves a static route untouched", () => {
    expect(normalizeRoutePattern("/pro/leads")).toBe("/pro/leads");
    expect(normalizeRoutePattern("/dashboard")).toBe("/dashboard");
  });

  it("strips a query string and hash before normalizing", () => {
    expect(normalizeRoutePattern("/chats?lead=abc123")).toBe("/chats");
    expect(normalizeRoutePattern("/dashboard#systems")).toBe("/dashboard");
  });

  it("replaces a uuid-shaped id segment", () => {
    expect(normalizeRoutePattern("/pro/crm/3f9a1c2e-4b5d-6789-a0bc-def012345678")).toBe(
      "/pro/crm/:id"
    );
  });

  it("replaces a short token-shaped segment (household invite)", () => {
    expect(normalizeRoutePattern("/join/household/Ab3xQ9zK")).toBe(
      "/join/household/:id"
    );
  });

  it("replaces an all-digit id segment", () => {
    expect(normalizeRoutePattern("/p/48291")).toBe("/p/:id");
  });

  it("does not treat an ordinary lowercase hyphenated segment as an id", () => {
    expect(normalizeRoutePattern("/guides/home-maintenance-schedule")).toBe(
      "/guides/home-maintenance-schedule"
    );
  });

  it("normalizes the bare root path", () => {
    expect(normalizeRoutePattern("/")).toBe("/");
  });
});

describe("roundMetricValue", () => {
  it("rounds millisecond metrics to whole numbers", () => {
    expect(roundMetricValue("LCP", 1234.567)).toBe(1235);
    expect(roundMetricValue("TTFB", 89.2)).toBe(89);
  });

  it("keeps CLS at 3 decimal places, not rounded to a whole number", () => {
    expect(roundMetricValue("CLS", 0.12345)).toBe(0.123);
  });
});

describe("buildWebVitalsProps", () => {
  it("builds an ids/enums-only payload with a normalized path", () => {
    expect(
      buildWebVitalsProps("LCP", 2100.4, "good", "/pro/crm/abc-123-def?tab=notes")
    ).toEqual({
      metric: "LCP",
      value: 2100,
      rating: "good",
      path: "/pro/crm/:id",
      sample_rate: WEB_VITALS_SAMPLE_RATE,
    });
  });
});
