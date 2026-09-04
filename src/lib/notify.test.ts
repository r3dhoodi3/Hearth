import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// notify.ts imports "server-only" and pulls in the service-role client
// (createAdminClient), neither of which resolves in a test process. Stubbed
// so withinMarketingBudget - the pure-ish exported function this file exists
// to test - can be driven for real, same pattern every other test that
// imports a server-only module directly already uses (src/lib/aiAbuse.test.ts
// and others).
vi.mock("server-only", () => ({}));
let countResult: { count: number | null; error: { message: string } | null } = {
  count: 0,
  error: null,
};
let notCalls: { column: string; op: string; value: unknown }[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (_table: string) => {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: chain,
        eq: chain,
        gte: chain,
        not: (column: string, op: string, value: unknown) => {
          notCalls.push({ column, op, value });
          return Promise.resolve(countResult);
        },
      });
      return api;
    },
  }),
}));

import { withinMarketingBudget, sendEmail, isEmailOptOutExempt } from "./notify";
import { MARKETING_BUDGET_MAX_PER_WINDOW } from "./notifyGating";

beforeEach(() => {
  countResult = { count: 0, error: null };
  notCalls = [];
});

describe("withinMarketingBudget", () => {
  it("allows a transactional kind without touching the database", async () => {
    const allowed = await withinMarketingBudget("user-1", "message");
    expect(allowed).toBe(true);
    // No .not(...) call recorded means the count query never ran.
    expect(notCalls).toHaveLength(0);
  });

  it("allows a marketing kind below the ceiling", async () => {
    countResult = { count: MARKETING_BUDGET_MAX_PER_WINDOW - 1, error: null };
    expect(await withinMarketingBudget("user-1", "seasonal_check")).toBe(true);
  });

  it("blocks a marketing kind once the ceiling is reached", async () => {
    countResult = { count: MARKETING_BUDGET_MAX_PER_WINDOW, error: null };
    expect(await withinMarketingBudget("user-1", "seasonal_check")).toBe(false);
  });

  it("FAILS CLOSED when the count read errors", async () => {
    // The opposite direction from the email opt-out check in this same file:
    // an outage must not let a campaign send unmetered.
    countResult = { count: null, error: { message: "db unavailable" } };
    expect(await withinMarketingBudget("user-1", "seasonal_check")).toBe(false);
  });

  it("excludes the transactional kinds from the count query", async () => {
    countResult = { count: 0, error: null };
    await withinMarketingBudget("user-1", "review_request");
    expect(notCalls).toHaveLength(1);
    expect(notCalls[0].column).toBe("kind");
    expect(notCalls[0].op).toBe("in");
    // The exclusion list is every transactional kind, parenthesized - just
    // spot-check a couple of representative members rather than the whole
    // enum (that full list is asserted in notifyGating.test.ts).
    expect(notCalls[0].value).toContain("message");
    expect(notCalls[0].value).toContain("payment_failed");
  });
});

// The CAN-SPAM opt-out exemption: unsubscribing turns off digests and
// product updates, never the mail about a person's own account, billing, or
// an active job (see the /unsubscribe confirmation copy and the "never gate
// a billing notice" reasoning in src/lib/notifyGating.ts). sendEmail is
// driven directly here (knownOptOut passed explicitly) so the database
// opt-out lookup never has to be mocked: isEmailOptOutExempt short-circuits
// the whole check before that lookup would run.
describe("email opt-out exemption", () => {
  const email = "member@example.com";

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM", "OakTend <hello@example.com>");
    // sendEmail signs an unsubscribe link with this secret; a real value here
    // is what lets execution reach the fetch() call at all instead of the
    // outer try/catch silently swallowing a thrown signing error.
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("isEmailOptOutExempt: exempts transactional/billing kinds, not digests", () => {
    expect(isEmailOptOutExempt("renewal_acknowledgment")).toBe(true);
    expect(isEmailOptOutExempt("payment_failed")).toBe(true);
    expect(isEmailOptOutExempt("home_digest")).toBe(false);
    expect(isEmailOptOutExempt("seasonal_check")).toBe(false);
  });

  it("blocks a digest kind for an opted-out recipient", async () => {
    await sendEmail(
      { userId: "user-1", kind: "home_digest", title: "Your home digest", email },
      /* knownOptOut */ true
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not block a transactional kind for an opted-out recipient", async () => {
    await sendEmail(
      {
        userId: "user-1",
        kind: "renewal_acknowledgment",
        title: "Your OakTend Plus subscription",
        email,
      },
      /* knownOptOut */ true
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // EMAIL_TRANSACTIONAL_KINDS is now an explicit allowlist, not the union
  // with TRANSACTIONAL_NOTIFICATION_KINDS (src/lib/notifyGating.ts). That
  // union used to carry new_review, referral_reward, and the freeze/heat/
  // high_wind/heavy_rain/recall safety alerts into email's opt-out exemption
  // too, even though none of those is account, billing, or active-job mail.
  it("blocks a new_review email for an opted-out recipient", async () => {
    await sendEmail(
      { userId: "user-1", kind: "new_review", title: "You got a new review", email },
      /* knownOptOut */ true
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a freeze-warning email for an opted-out recipient", async () => {
    await sendEmail(
      { userId: "user-1", kind: "freeze", title: "Freeze warning tonight", email },
      /* knownOptOut */ true
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still sends a payment_failed email to an opted-out recipient", async () => {
    await sendEmail(
      { userId: "user-1", kind: "payment_failed", title: "Your payment failed", email },
      /* knownOptOut */ true
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
