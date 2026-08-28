import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/lib/homeValue.ts has ONE chooser for a home's headline value:
// headlineHomeValue(), which prefers the stored RentCast AVM and falls back to
// the capped purchase-price model. Its whole point is that every screen and
// every email quote the same number on the same day.
//
// That only holds if nobody reaches past it. Four places used to call
// estimateHomeValue() directly (the dashboard tile, /value, /taxes,
// /api/tax-appeal and /api/cron/home-digest), which is how a homeowner could
// read one value on the dashboard, a different one on the taxes page, and a
// third in their monthly digest email. Worse, the direct callers never looked
// at market_value at all, so an owner with a real AVM on file got the
// statewide-average guess everywhere except the two screens that had been
// fixed.
//
// A regression here is invisible: adding `estimateHomeValue` to an import and
// calling it compiles, passes every other test, and looks perfectly correct in
// review. So this is a source-text test, the same trick
// src/lib/ownershipChecks.test.ts and src/lib/photoUrlDbBinding.test.ts use.
// If it goes red, someone has gone around the chooser again.

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));
// This test file lives in src/lib itself, so its own directory IS src/lib -
// used below to reach src/lib/homeDigestLine.ts, which is where the
// home-digest cron's headlineHomeValue() call actually lives now (moved out
// of the route module: a Next.js route file may only export its HTTP
// handlers and a small set of config names, so the shared value-line builder
// had to move to its own module).
const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Comments are stripped before the search: the three files converted away from
// estimateHomeValue explain in prose why they no longer call it, and a test
// that failed on its own explanation would be useless. Deliberately crude
// (a "//" inside a string literal eats the rest of that line), which can only
// ever make this check miss something, never fail on innocent code.
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Every site that turns a property row into a headline value. Named
// explicitly, not globbed, so adding one is a deliberate act: a new screen or
// job that shows a home's value has to come here and prove it uses the shared
// chooser.
const HEADLINE_VALUE_SITES = [
  "(app)/dashboard/page.tsx",
  "(app)/value/page.tsx",
  "(app)/taxes/page.tsx",
  "api/tax-appeal/route.ts",
  "api/cron/home-digest/route.ts",
];

// Where each site's actual headlineHomeValue() call lives, when it is not
// the site's own route/page file. Only home-digest indirects through a
// helper module today; every other site calls the chooser directly.
const HEADLINE_VALUE_CALL_SITE: Record<string, string> = {
  "api/cron/home-digest/route.ts": `${LIB_DIR}homeDigestLine.ts`,
};

function appSource(rel: string): string {
  return readFileSync(`${APP_DIR}/${rel}`, "utf8");
}

// The source actually searched for the headlineHomeValue()/market_value
// assertions below: the override path when one is registered, the site's own
// file otherwise.
function callSiteSource(rel: string): string {
  const override = HEADLINE_VALUE_CALL_SITE[rel];
  return withoutComments(readFileSync(override ?? `${APP_DIR}/${rel}`, "utf8"));
}

describe("the single chooser for a home's headline value", () => {
  it("is the only way anything under src/app values a home", () => {
    const offenders = sourceFiles(APP_DIR).filter((file) =>
      /\bestimateHomeValue\b/.test(withoutComments(readFileSync(file, "utf8")))
    );
    // The path is in the message so a failure names the file to fix rather
    // than just reporting a count.
    expect(
      offenders.map((f) => f.slice(APP_DIR.length + 1).replace(/\\/g, "/"))
    ).toEqual([]);
  });

  for (const rel of HEADLINE_VALUE_SITES) {
    it(`${rel} asks headlineHomeValue for the number`, () => {
      const src = callSiteSource(rel);
      expect(src).toMatch(/headlineHomeValue\s*\(/);
    });

    it(`${rel} passes the stored AVM in, so it can actually win`, () => {
      // Calling the chooser but handing it marketValue: null would quietly
      // pin every one of these back to the fallback model, which is exactly
      // the bug this file exists to catch, just spelled differently.
      const src = withoutComments(appSource(rel));
      expect(src).toMatch(/market_value\b/);
      expect(src).toMatch(/market_value_low\b/);
      expect(src).toMatch(/market_value_high\b/);
    });
  }

  it("api/cron/home-digest/route.ts gets its value line from the shared homeDigestLine helper", () => {
    // The route no longer calls headlineHomeValue itself (see the override
    // above); this pins that it still reaches the chooser indirectly, by
    // importing the one function in src/lib/homeDigestLine.ts that calls it,
    // rather than quietly growing a second, divergent value calculation.
    const src = withoutComments(appSource("api/cron/home-digest/route.ts"));
    expect(src).toMatch(
      /import\s*\{\s*homeValueEquityLine\s*\}\s*from\s*["']@\/lib\/homeDigestLine["']/
    );
  });
});
