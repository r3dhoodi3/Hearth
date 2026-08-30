import { beforeEach, describe, expect, it, vi } from "vitest";

// THE BUILDING-RECORD GATE, on the tax-appeal route. The route builds the
// appeal letter's central claim (the assessment is too high) from
// assessed_value and purchase_price read straight off the property row. Both
// can be the whole building's, not the unit's, for a condo or multi-family
// home - the same $34,000,000 purchase price and $36,410,541 county
// assessment a real tester was shown on /value and /taxes for a $799,000
// condo (see src/lib/parcelSanity.ts). This test pins that the route refuses
// before ever calling the model or spending one of the owner's daily AI
// usages, using the mocking pattern from src/app/api/health/route.test.ts
// (vi.mock factories for every module that would otherwise need real I/O).

const sessionUser = { id: "user-1", email: "owner@example.com" };

// The route now takes the request so it can check where the call came from
// (src/lib/csrf.ts). These tests are about the building-record gate, so they
// hand it an ordinary same-origin POST, exactly like the app's own fetch.
function sameOriginRequest(): any {
  return new Request("https://gethearth.vercel.app/api/tax-appeal", {
    method: "POST",
    headers: {
      host: "gethearth.vercel.app",
      "sec-fetch-site": "same-origin",
    },
  });
}

let activeProperty: Record<string, unknown> | null = null;
let plusTier: "free" | "trialing" | "paid" = "paid";

let countAiUsageCalled = false;
let refundAiUsageCalled = false;
let hasClaudeKeyCalled = false;
let generateTextCalled = false;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  })),
}));

vi.mock("@/lib/subscription", () => ({
  getPlusTier: vi.fn(async () => plusTier),
}));

vi.mock("@/lib/property", () => ({
  getActiveProperty: vi.fn(async () => activeProperty),
}));

vi.mock("@/lib/aiUsage", () => ({
  // Neither should ever run on the refused path: countAiUsage would spend
  // one of the owner's daily usages on a letter that was never drafted, and
  // refundAiUsage only makes sense after a spend. Tracked rather than thrown
  // so a bug here fails on the assertion, not on an unhandled rejection.
  countAiUsage: vi.fn(async () => {
    countAiUsageCalled = true;
    return { overLimit: false, reason: null };
  }),
  refundAiUsage: vi.fn(async () => {
    refundAiUsageCalled = true;
  }),
}));

vi.mock("@/lib/claude", () => ({
  hasClaudeKey: vi.fn(() => {
    hasClaudeKeyCalled = true;
    return true;
  }),
  generateText: vi.fn(async () => {
    generateTextCalled = true;
    return { text: "a letter that should never be drafted", stopReason: "end_turn" };
  }),
  isRateLimitError: vi.fn(() => false),
}));

// A condo in a large mixed-use parcel: a unit number, a small AVM estimate,
// and county figures that are really the building's - the tester's exact
// numbers from parcelSanity.ts's own header comment.
const BUILDING_LEVEL_PROPERTY = {
  id: "property-1",
  user_id: "user-1",
  unit: "204",
  property_type: "multi_family",
  sqft: 1_100,
  beds: 2,
  baths: 2,
  year_built: 2005,
  city: "Anaheim",
  state: "CA",
  purchase_date: "2017-01-01",
  purchase_price: 34_000_000,
  assessed_value: 36_410_541,
  assessed_year: 2026,
  market_value: 799_000,
  market_value_low: null,
  market_value_high: null,
};

// A plain single-family home with the same shape assessment set up so the
// happy path (no gate refusal) is exercised for contrast.
const SINGLE_FAMILY_PROPERTY = {
  id: "property-2",
  user_id: "user-1",
  unit: null,
  property_type: "single_family",
  sqft: 1_800,
  beds: 3,
  baths: 2,
  year_built: 1998,
  city: "Fountain Valley",
  state: "TX", // non-CA: comparison basis is the market estimate, not Prop 13
  purchase_date: "2015-01-01",
  purchase_price: 200_000,
  assessed_value: 500_000,
  assessed_year: 2026,
  market_value: 400_000,
  market_value_low: null,
  market_value_high: null,
};

beforeEach(() => {
  activeProperty = BUILDING_LEVEL_PROPERTY;
  plusTier = "paid";
  countAiUsageCalled = false;
  refundAiUsageCalled = false;
  hasClaudeKeyCalled = false;
  generateTextCalled = false;
});

describe("the building-record gate on /api/tax-appeal", () => {
  it("refuses a building-level assessment/purchase price before any model call", async () => {
    const { POST } = await import("./route");

    const res = await POST(sameOriginRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      error:
        "County records for this address cover the whole building, not your unit, so we can't draft an appeal from them.",
    });
    // Nothing was counted, nothing was refunded, no key was checked, and no
    // model call happened: the gate ran before all of it.
    expect(countAiUsageCalled).toBe(false);
    expect(refundAiUsageCalled).toBe(false);
    expect(hasClaudeKeyCalled).toBe(false);
    expect(generateTextCalled).toBe(false);
  });

  it("still refuses when only the purchase price (not the assessed value) is implausible", async () => {
    activeProperty = {
      ...BUILDING_LEVEL_PROPERTY,
      // A plausible assessment on its own, paired with the building's sale
      // price: the letter would still cite an invented purchase year and
      // price in its "Purchased in ... for $..." fact.
      assessed_value: 900_000,
    };
    const { POST } = await import("./route");

    const res = await POST(sameOriginRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("whole building");
    expect(generateTextCalled).toBe(false);
  });

  it("does not refuse a plausible single-family assessment", async () => {
    activeProperty = SINGLE_FAMILY_PROPERTY;
    const { POST } = await import("./route");

    const res = await POST(sameOriginRequest());
    const body = await res.json();

    // Reaches the model call this time: the gate let it through.
    expect(res.status).toBe(200);
    expect(body.letter).toBe("a letter that should never be drafted");
    expect(generateTextCalled).toBe(true);
  });

  it("refuses a cross-site caller before it does any work", async () => {
    activeProperty = SINGLE_FAMILY_PROPERTY;
    const { POST } = await import("./route");

    const res = await POST(
      new Request("https://gethearth.vercel.app/api/tax-appeal", {
        method: "POST",
        headers: {
          host: "gethearth.vercel.app",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      }) as any
    );

    expect(res.status).toBe(403);
    // The guard runs first, so nothing was spent on a request we refused.
    expect(generateTextCalled).toBe(false);
    expect(countAiUsageCalled).toBe(false);
  });
});
