import { describe, expect, it } from "vitest";
import {
  checkBudget,
  parseFirstLoadJs,
  PERCENT_TOLERANCE,
  sizeStringToBytes,
} from "./checkBundleBudget.mjs";

// Pins the parsing of `next build`'s own stdout table (so a future Next
// version reformatting that table is caught here, not by a silently
// no-op'd CI check) and the 10%-over-baseline budget rule.

describe("sizeStringToBytes", () => {
  it("converts kB, B, and MB using 1024-based units, matching Next's formatter", () => {
    expect(sizeStringToBytes("132 kB")).toBe(135168);
    expect(sizeStringToBytes("419 B")).toBe(419);
    expect(sizeStringToBytes("1.15 MB")).toBe(Math.round(1.15 * 1024 * 1024));
  });

  it("returns null for an unrecognized string", () => {
    expect(sizeStringToBytes("n/a")).toBeNull();
  });
});

describe("parseFirstLoadJs", () => {
  const SAMPLE_TABLE = `
Route (app)                                                         Size  First Load JS  Revalidate  Expire
┌ ƒ /                                                            4.18 kB         116 kB
├ ƒ /dashboard                                                   11.9 kB         132 kB
├ ○ /guides/home-maintenance-schedule                            1.08 kB         107 kB          1h      1y
└ ƒ /welcome/role                                                  194 B         106 kB
+ First Load JS shared by all                                     102 kB
  ├ chunks/1255-d3668eefd1b4a69b.js                              46.1 kB
  └ other shared chunks (total)                                  2.11 kB
`;

  it("extracts First Load JS per route, skipping non-route rows", () => {
    const routes = parseFirstLoadJs(SAMPLE_TABLE);
    expect(routes["/"]).toBe(sizeStringToBytes("116 kB"));
    expect(routes["/dashboard"]).toBe(sizeStringToBytes("132 kB"));
    expect(routes["/guides/home-maintenance-schedule"]).toBe(sizeStringToBytes("107 kB"));
    expect(routes["/welcome/role"]).toBe(sizeStringToBytes("106 kB"));
    // The shared-chunk footer and its sub-rows never start with "/" - they
    // must not be mistaken for a route.
    expect(Object.keys(routes)).toHaveLength(4);
  });
});

describe("checkBudget", () => {
  const baseline = { "/dashboard": 100000, "/pro": 200000 };

  it("passes a route at or under the baseline", () => {
    const rows = checkBudget({ "/dashboard": 100000, "/pro": 180000 }, baseline);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("passes a route within the tolerance", () => {
    const rows = checkBudget(
      { "/dashboard": 100000 * (1 + PERCENT_TOLERANCE), "/pro": 200000 },
      baseline
    );
    expect(rows.find((r) => r.route === "/dashboard").ok).toBe(true);
  });

  it("fails a route that grew past the tolerance", () => {
    const rows = checkBudget(
      { "/dashboard": 100000 * (1 + PERCENT_TOLERANCE) + 1, "/pro": 200000 },
      baseline
    );
    const dashboard = rows.find((r) => r.route === "/dashboard");
    expect(dashboard.ok).toBe(false);
    expect(dashboard.percentChange).toBeGreaterThan(PERCENT_TOLERANCE * 100);
  });

  it("flags a baseline route missing from the current build instead of skipping it", () => {
    const rows = checkBudget({ "/pro": 200000 }, baseline);
    const dashboard = rows.find((r) => r.route === "/dashboard");
    expect(dashboard.ok).toBe(false);
    expect(dashboard.currentBytes).toBeNull();
  });

  it("allows a route that shrank", () => {
    const rows = checkBudget({ "/dashboard": 50000, "/pro": 200000 }, baseline);
    expect(rows.find((r) => r.route === "/dashboard").ok).toBe(true);
  });
});
