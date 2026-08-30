import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  FREE_ASK_PER_DAY,
  PLUS_ASK_PER_DAY,
  PLUS_INCLUDED_HOMES,
  TRIAL_ASK_PER_DAY,
} from "@/lib/constants";

// src/lib/aiUsage.ts imports the service-role Supabase client, which is
// "server-only" and throws the moment it is imported outside a server
// component - so the /plus card cannot import ASK_DAILY_PLUS and constants.ts
// carries a mirror of it instead. This test is what keeps the mirror honest:
// it reads aiUsage.ts's source, the same way src/lib/aiUsage.test.ts does.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function constant(source: string, name: string): number {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  if (!m) throw new Error(`${name} was not found as a plain numeric constant`);
  return Number(m[1]);
}

describe("the Plus allowances quoted in marketing copy", () => {
  it("quotes the same daily question count the server enforces", () => {
    expect(PLUS_ASK_PER_DAY).toBe(constant(src("./aiUsage.ts"), "ASK_DAILY_PLUS"));
  });

  it("quotes the same free question count the server enforces", () => {
    // The number in every "Free" column on /plus and /pricing. A drift here is
    // a promise the free tier does not keep, in the direction people notice.
    expect(FREE_ASK_PER_DAY).toBe(constant(src("./aiUsage.ts"), "ASK_DAILY_FREE"));
  });

  // The trial now gets the PAID ceiling, not a smaller one: the trial rides on
  // the weekly plan, and weekly, monthly, and annual must include exactly the
  // same things. Both sides are written as aliases rather than as a repeated
  // digit, so the check is that the alias is still an alias.
  it("gives the trial the same question count as a paid plan", () => {
    expect(TRIAL_ASK_PER_DAY).toBe(PLUS_ASK_PER_DAY);
    expect(src("./aiUsage.ts")).toContain(
      "export const ASK_DAILY_TRIAL = ASK_DAILY_PLUS;"
    );
    expect(src("./constants.ts")).toContain(
      "export const TRIAL_ASK_PER_DAY = PLUS_ASK_PER_DAY;"
    );
  });

  it("still keeps the trial well above the free allowance", () => {
    expect(TRIAL_ASK_PER_DAY).toBeGreaterThan(
      constant(src("./aiUsage.ts"), "ASK_DAILY_FREE")
    );
  });

  it("quotes the same home count the claim cap enforces", () => {
    // claimPropertyAction reads the constant rather than a literal, so this
    // asserts the import is still there: a re-hardcoded "5" would pass a plain
    // value check while drifting the moment the constant changed.
    const actions = src("../app/onboarding/actions.ts");
    expect(actions).toContain("PLUS_INCLUDED_HOMES");
    expect(PLUS_INCLUDED_HOMES).toBeGreaterThan(1);
  });
});
