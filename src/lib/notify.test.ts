import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { withinMarketingBudget } from "./notify";
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
