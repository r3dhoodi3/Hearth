// Does a free trial survive a broken subscriptions read?
//
// The Pro side already answered no (isProTrialEligible). The homeowner side
// gated its 3 free days on `!existing`, where `existing` is getSubscription()'s
// null return - and that null means BOTH "never subscribed" and "the read just
// failed". A churned subscriber whose read errored was handed the trial again,
// and could retry until it did. isPlusTrialEligible closes that by reading the
// errored flag directly.
//
// The module is exercised for real rather than at the level of source text:
// every server-only dependency is mocked out here, so importing it never pulls
// in "server-only". React's cache() falls through to a plain call when there is
// no request dispatcher, which is exactly what a per-test fresh read needs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  plan: string | null;
  status: string | null;
  current_period_end?: string | null;
};

// What the fake subscriptions table returns for the test that is running.
let queryResult: { data: Row[] | null; error: { message: string } | null } = {
  data: [],
  error: null,
};
let currentUser: { id: string } | null = { id: "user-1" };

vi.mock("@/lib/auth", () => ({
  getUser: async () => currentUser,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: async () => queryResult,
      }),
    }),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }),
  }),
}));

vi.mock("@/lib/property", () => ({
  getActiveProperty: async () => null,
}));

vi.mock("@/lib/stripe", () => ({
  stripe: { subscriptions: { retrieve: async () => ({}) } },
}));

const { isPlusTrialEligible, isProTrialEligible } = await import(
  "@/lib/subscription"
);

const ok = (rows: Row[]) => {
  queryResult = { data: rows, error: null };
};
const failed = () => {
  queryResult = { data: null, error: { message: "permission denied" } };
};

beforeEach(() => {
  currentUser = { id: "user-1" };
  ok([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isPlusTrialEligible", () => {
  it("is eligible when the account has no homeowner-side row at all", () => {
    return expect(isPlusTrialEligible()).resolves.toBe(true);
  });

  it("is NOT eligible once a homeowner-side row exists, on any cadence", async () => {
    for (const plan of ["weekly", "monthly", "yearly"]) {
      ok([{ plan, status: "active" }]);
      await expect(isPlusTrialEligible(), plan).resolves.toBe(false);
    }
  });

  it("is NOT eligible for a churned subscriber: the row survives cancellation", async () => {
    // This is the whole point of reading the row rather than asking whether
    // the membership is live: a canceled row is not deleted, it lands on
    // status "canceled", and that person has already used their free days.
    ok([{ plan: "weekly", status: "canceled" }]);
    await expect(isPlusTrialEligible()).resolves.toBe(false);
    ok([{ plan: "monthly", status: "incomplete_expired" }]);
    await expect(isPlusTrialEligible()).resolves.toBe(false);
  });

  it("fails CLOSED when the subscriptions read errors", async () => {
    // The trial-farming path: retry until the read breaks. `!existing` would
    // be true here, because a failed read also produces a null row.
    failed();
    await expect(isPlusTrialEligible()).resolves.toBe(false);
  });

  it("ignores the Pro-side row: a pro who never had Plus can still trial it", async () => {
    ok([{ plan: "pro_monthly", status: "active" }]);
    await expect(isPlusTrialEligible()).resolves.toBe(true);
  });

  it("sees the homeowner row on a dual-side account", async () => {
    ok([
      { plan: "pro_yearly", status: "active" },
      { plan: "monthly", status: "canceled" },
    ]);
    await expect(isPlusTrialEligible()).resolves.toBe(false);
  });
});

describe("isProTrialEligible is the exact mirror", () => {
  it("ignores the homeowner row and fails closed the same way", async () => {
    ok([{ plan: "monthly", status: "active" }]);
    await expect(isProTrialEligible()).resolves.toBe(true);
    ok([{ plan: "pro_monthly", status: "canceled" }]);
    await expect(isProTrialEligible()).resolves.toBe(false);
    failed();
    await expect(isProTrialEligible()).resolves.toBe(false);
  });
});

// The predicate only helps if checkout actually calls it, and the double
// checkout guard only helps if it runs before Stripe is consulted. Source-text
// checks, the same trick src/lib/homeValueCallers.test.ts uses: both wirings
// compile and look right either way.
describe("checkout wiring", () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  const plus = src("app/(app)/plus/actions.ts");
  const proPlus = src("app/pro/plus/actions.ts");

  it("the Plus checkout gates its trial on the fail-closed predicate", () => {
    expect(plus).toContain("isPlusTrialEligible");
    // The paywall experiment's variant is one more AND in the same expression
    // (src/lib/paywallExperiment.ts): "hard" is one more reason the trial does
    // not apply, and the fail-closed predicate and risk gate stay in place.
    expect(plus).toContain(
      'trialApplies(plan, (await isPlusTrialEligible()) && risk.allowTrial && paywallVariant === "soft")'
    );
    // The signal it replaced must not survive alongside it.
    expect(plus).not.toContain("!existing && risk.allowTrial");
  });

  it("both checkouts refuse a second membership on our own live row", () => {
    // The Stripe-side guard below each of these only runs when a customer id
    // exists, and that id comes from a subscriptions row - so a row with no
    // stripe_customer_id skipped the guard entirely.
    for (const [name, source] of [
      ["plus", plus],
      ["pro/plus", proPlus],
    ] as const) {
      expect(source, name).toMatch(
        /const liveExisting =[\s\S]{0,160}existing\.status === "active" \|\| existing\.status === "trialing"/
      );
      expect(source, name).toContain("if (liveExisting) {");
    }
  });

  it("that guard sits before the Stripe subscriptions.list call", () => {
    for (const [name, source] of [
      ["plus", plus],
      ["pro/plus", proPlus],
    ] as const) {
      expect(
        source.indexOf("if (liveExisting) {"),
        name
      ).toBeLessThan(source.indexOf("stripe.subscriptions.list"));
    }
  });
});
