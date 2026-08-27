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

function appSource(rel: string): string {
  return readFileSync(`${APP_DIR}/${rel}`, "utf8");
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
      const src = withoutComments(appSource(rel));
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
});
