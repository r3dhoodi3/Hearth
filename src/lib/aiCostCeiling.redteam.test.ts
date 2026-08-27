import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// RED-TEAM CHARACTERISATION TESTS (added by the 2026-08-26 kill-chain audit).
//
// Nothing here is a bug in the sense of "this code does not do what it says".
// Every limit in src/lib/aiUsage.ts does exactly what its comments promise.
// These tests are about what the promises ADD UP TO, which is a different
// question and the one an attacker asks.
//
// Two gaps, both written as `it.fails` so the suite stays green while the gap
// is on the record. When either is fixed, delete the `.fails` and the test
// starts guarding the fix.
//
//   1. AI_GLOBAL_DAILY_LIMIT is denominated in REQUESTS. The cost of a
//      request is not a constant: the cheapest AI route can push ~2 KB at the
//      model and the most expensive can push ~26 MB, so "5000 a day" is a
//      dollar figure anywhere between about $15 and about $1,600 depending on
//      which route the 5000 land on. A spend breaker that cannot see spend is
//      a request breaker with a spend breaker's name.
//
//   2. countAiUsage charges the caller's own daily allowance BEFORE it checks
//      Hearth's owner-wide ceilings, and does not hand it back when one of
//      those ceilings refuses the request. The chat path (countAskUsage) does
//      hand it back - refundAskUsage exists for exactly this - so the two
//      halves of the same file disagree about who pays for Hearth's brakes.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const aiUsage = src("./aiUsage.ts");
const constants = src("./constants.ts");

function num(source: string, name: string): number {
  const m = new RegExp(`export const ${name} = ([\\d_]+);`).exec(source);
  if (!m) throw new Error(`${name} is not exported`);
  return Number(m[1].replace(/_/g, ""));
}

// The per-route body ceiling, read straight out of each route file, in bytes.
function bodyCap(route: string): number {
  const source = src(`../app/api/${route}/route.ts`);
  const m = /const MAX_BODY_BYTES = ([\d_]+);/.exec(source);
  if (!m) throw new Error(`${route} declares no MAX_BODY_BYTES`);
  return Number(m[1].replace(/_/g, ""));
}

// Every AI route that funnels through the shared global breaker and declares
// its own body ceiling.
const METERED_ROUTES = [
  "ask",
  "pro-ask",
  "analyze-quote",
  "extract-document",
  "ingest-inspection",
  "confirm-system",
  "draft-apply",
  "draft-job",
  "pro-tools",
];

describe("the owner-wide breaker is a REQUEST count, not a spend cap", () => {
  it("every metered route shares one bucket with one number in it", () => {
    // This is the design, and it is the thing worth being explicit about: the
    // only ceiling standing between a swarm of free accounts and the Claude
    // bill is a single integer counted once per request.
    expect(constants).toContain("AI_GLOBAL_DAILY_LIMIT");
    expect(aiUsage).toContain("p_limit: AI_GLOBAL_DAILY_LIMIT");
    expect(aiUsage).toContain("p_bucket: AI_GLOBAL_BUCKET");
  });

  it("the heaviest request a user may send is orders of magnitude bigger than the lightest", () => {
    const caps = METERED_ROUTES.map(bodyCap);
    const cheapest = Math.min(...caps);
    const dearest = Math.max(...caps);
    // draft-apply/draft-job cap at 512 KB; ingest-inspection at 26 MB. Both
    // spend exactly ONE unit of the 5000-a-day global budget.
    expect(dearest / cheapest).toBeGreaterThan(40);
  });

  it.fails(
    "caps what the global budget can cost, not just how many times it is spent",
    () => {
      // What a dollar-denominated breaker would look like: the global bucket
      // weighted by the size of the request, the way addAiUsage already
      // weights the PER-USER counter for a fan-out route. Nothing in
      // aiUsage.ts passes a weight to the global bucket today, so the worst
      // realistic day is (AI_GLOBAL_DAILY_LIMIT x the dearest request) rather
      // than (AI_GLOBAL_DAILY_LIMIT x an average one).
      expect(aiUsage).toMatch(/AI_GLOBAL_DAILY_(BUDGET|CENTS|TOKENS)/);
    }
  );

  it.fails(
    "counts a fan-out route's extra model calls against the global bucket too",
    () => {
      // addAiUsage(userId, extra) exists and is called by analyze-quote (a
      // second stage) and ingest-inspection (one per extra page). Both bumps
      // land on the PER-USER counter only. The global breaker still sees one.
      // So 5000 global units can be 15000 real model calls.
      const breaker = aiUsage.slice(
        aiUsage.indexOf("async function checkAiGlobalDailyLimit")
      );
      const call = breaker.slice(
        breaker.indexOf("rate_limit_hit"),
        breaker.indexOf("rate_limit_hit") + 300
      );
      expect(call).toMatch(/p_delta|p_weight/);
    }
  );
});

describe("who pays when Hearth's own ceiling sheds a request", () => {
  it("the CHAT path hands the question back", () => {
    // countAskUsage: charge, then if the global breaker says no, refund.
    const chat = aiUsage.slice(
      aiUsage.indexOf("export async function countAskUsage")
    );
    const shed = chat.indexOf("const globalDaily = await checkAiGlobalDailyLimit()");
    expect(shed).toBeGreaterThan(-1);
    expect(chat.slice(shed, shed + 400)).toContain("refundAskUsage");
  });

  it("the TOOL path hands the usage back the same way", () => {
    // FIXED 2026-08-26. bump_ai_usage has already run by the time either
    // global ceiling is consulted, and neither branch used to call
    // refundAiUsage. A free homeowner who tried a document scan while a swarm
    // had the breaker tripped was charged one of their 25 for a request that
    // never reached the model - and the client is told "Hearth's AI is busy",
    // so they retried, and were charged again, until their day was gone. Both
    // shed branches in countAiUsage now refund, the way countAskUsage always
    // has.
    const tool = aiUsage.slice(
      aiUsage.indexOf("export async function countAiUsage"),
      aiUsage.indexOf("export async function countAskUsage")
    );
    const shed = tool.indexOf("const globalDaily = await checkAiGlobalDailyLimit()");
    expect(shed).toBeGreaterThan(-1);
    expect(tool.slice(shed)).toContain("refundAiUsage");
  });
});

describe("the numbers an operator should be able to state out loud", () => {
  it("records today's ceiling so a change to it is a visible diff", () => {
    // Not a judgement, a tripwire: if someone raises this to 50000 without
    // also weighting the bucket, the blast radius goes up 10x silently.
    expect(num(constants, "AI_GLOBAL_DAILY_LIMIT")).toBe(5000);
    expect(num(aiUsage, "AI_GLOBAL_HOURLY_LIMIT")).toBe(1500);
    // 200 free accounts x DAILY_LIMIT_FREE is the whole global budget. That
    // relationship is the attack, and it is arithmetic, not a bug.
    const accountsToExhaust =
      num(constants, "AI_GLOBAL_DAILY_LIMIT") / num(aiUsage, "DAILY_LIMIT_FREE");
    expect(accountsToExhaust).toBeLessThanOrEqual(200);
  });

  it.fails("alerts a human when the breaker trips", () => {
    // Today a tripped breaker is a console.error in the Vercel log. Nothing
    // pages anyone, so the first report of a total AI outage is a customer.
    const breaker = aiUsage.slice(aiUsage.indexOf("AI global spend breaker tripped"));
    expect(breaker.slice(0, 600)).toMatch(/notify|alert|resend|sendEmail|webhook/i);
  });
});
