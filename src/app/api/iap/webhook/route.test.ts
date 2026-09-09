import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route pulls in the service-role client, which imports "server-only" and
// is unresolvable under vitest. Mocked with a factory, the same pattern the
// cron route tests use, so the route itself can be imported and driven for
// real.

// ---------------------------------------------------------------------------
// Fake admin client state, reset per test.
// ---------------------------------------------------------------------------
type Row = {
  status?: string | null;
  plan?: string | null;
  current_period_end?: string | null;
  updated_at?: string | null;
  stripe_subscription_id?: string | null;
};

const USER_ID = "11111111-2222-3333-4444-555555555555";

let existingRow: Row | null = null;
let readError: { message: string; code?: string } | null = null;
let authUser: { id: string } | null = { id: USER_ID };
let authError: { message: string; status?: number } | null = null;
let upserts: Array<{ payload: Record<string, unknown>; onConflict?: string }> = [];
let upsertError: { message: string; code?: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin(),
}));

function fakeAdmin() {
  return {
    auth: {
      admin: {
        getUserById: async () =>
          authError
            ? { data: { user: null }, error: authError }
            : { data: { user: authUser }, error: null },
      },
    },
    from() {
      const api: Record<string, unknown> = {};
      Object.assign(api, {
        select: () => api,
        eq: () => api,
        // The route awaits the builder straight after .eq(), so the fake is
        // thenable rather than ending in .maybeSingle().
        then: (
          resolve: (value: { data: Row[] | null; error: unknown }) => unknown
        ) => resolve({ data: existingRow ? [existingRow] : [], error: readError }),
        upsert: async (
          payload: Record<string, unknown>,
          opts?: { onConflict?: string }
        ) => {
          upserts.push({ payload, onConflict: opts?.onConflict });
          return { error: upsertError };
        },
      });
      return api;
    },
  };
}

// ---------------------------------------------------------------------------
// Request helper. Only headers and json() are read by the route.
// ---------------------------------------------------------------------------
const SECRET = "rc_test_secret_value";

function req(body: unknown, authorization?: string): NextRequest {
  const headers = new Map<string, string>();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return {
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as NextRequest;
}

const AT = Date.UTC(2026, 8, 7, 12, 0, 0); // event_timestamp_ms for every event below

function event(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: "evt_1",
      type: "INITIAL_PURCHASE",
      app_user_id: USER_ID,
      entitlement_ids: ["oaktend_plus"],
      product_id: "oaktend_plus_monthly",
      period_type: "NORMAL",
      environment: "PRODUCTION",
      event_timestamp_ms: AT,
      expiration_at_ms: AT + 30 * 24 * 60 * 60 * 1000,
      ...overrides,
    },
  };
}

let POST: (req: NextRequest) => Promise<Response>;

const ORIGINAL_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;
const ORIGINAL_SANDBOX = process.env.REVENUECAT_ALLOW_SANDBOX;
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

beforeEach(async () => {
  existingRow = null;
  readError = null;
  authUser = { id: USER_ID };
  authError = null;
  upserts = [];
  upsertError = null;
  process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
  // The route treats a non-production NODE_ENV with no VERCEL_ENV as a place
  // where sandbox events may grant, so the sandbox tests set VERCEL_ENV
  // explicitly. Default here is "production" so every other test exercises the
  // production posture.
  process.env.VERCEL_ENV = "production";
  delete process.env.REVENUECAT_ALLOW_SANDBOX;
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.REVENUECAT_WEBHOOK_SECRET;
  else process.env.REVENUECAT_WEBHOOK_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_SANDBOX === undefined) delete process.env.REVENUECAT_ALLOW_SANDBOX;
  else process.env.REVENUECAT_ALLOW_SANDBOX = ORIGINAL_SANDBOX;
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
});

describe("RevenueCat webhook auth", () => {
  it("accepts the configured bearer token", async () => {
    const res = await POST(req(event(), `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
  });

  it("rejects a missing Authorization header", async () => {
    const res = await POST(req(event()));
    expect(res.status).toBe(401);
    expect(upserts).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    const res = await POST(req(event(), "Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(upserts).toHaveLength(0);
  });

  it("rejects a bare secret with no Bearer prefix", async () => {
    const res = await POST(req(event(), SECRET));
    expect(res.status).toBe(401);
  });

  it("rejects a correct-prefix token of the right length but wrong bytes", async () => {
    const wrong = SECRET.slice(0, -1) + (SECRET.endsWith("x") ? "y" : "x");
    const res = await POST(req(event(), `Bearer ${wrong}`));
    expect(res.status).toBe(401);
  });

  it("rejects EVERYTHING when REVENUECAT_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    vi.resetModules();
    ({ POST } = await import("./route"));
    // An unconfigured webhook must not become an open "grant anyone Plus"
    // endpoint: both the empty header and a guessed one are refused.
    expect((await POST(req(event()))).status).toBe(401);
    expect((await POST(req(event(), "Bearer "))).status).toBe(401);
    expect((await POST(req(event(), "Bearer anything"))).status).toBe(401);
    expect(upserts).toHaveLength(0);
  });
});

describe("RevenueCat webhook idempotency and ordering", () => {
  it("does not write twice when the same event is redelivered", async () => {
    const first = await POST(req(event(), `Bearer ${SECRET}`));
    expect(first.status).toBe(200);
    expect(upserts).toHaveLength(1);

    // Simulate the row the first delivery wrote, then replay the identical
    // event the way RevenueCat does after a timeout.
    existingRow = {
      status: "active",
      plan: "monthly",
      current_period_end: null,
      updated_at: new Date(AT).toISOString(),
      stripe_subscription_id: null,
    };
    const replay = await POST(req(event(), `Bearer ${SECRET}`));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ skipped: true });
    expect(upserts).toHaveLength(1);
  });

  it("does not let a replayed EXPIRATION downgrade a member who has since renewed", async () => {
    // The renewal already landed and is the high-water mark.
    existingRow = {
      status: "active",
      plan: "monthly",
      current_period_end: new Date(AT + 60_000).toISOString(),
      updated_at: new Date(AT).toISOString(),
      stripe_subscription_id: null,
    };
    const stale = await POST(
      req(
        event({ type: "EXPIRATION", event_timestamp_ms: AT - 60_000 }),
        `Bearer ${SECRET}`
      )
    );
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ skipped: true });
    expect(upserts).toHaveLength(0);
  });

  it("still applies a genuinely newer event", async () => {
    existingRow = {
      status: "active",
      plan: "monthly",
      current_period_end: null,
      updated_at: new Date(AT).toISOString(),
      stripe_subscription_id: null,
    };
    const res = await POST(
      req(
        event({ type: "EXPIRATION", event_timestamp_ms: AT + 1000 }),
        `Bearer ${SECRET}`
      )
    );
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({ status: "canceled" });
  });
});

describe("RevenueCat webhook app_user_id validation", () => {
  it("drops an app_user_id that is not a uuid", async () => {
    const res = await POST(
      req(event({ app_user_id: "not-a-uuid" }), `Bearer ${SECRET}`)
    );
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(0);
  });

  it("drops a well-formed uuid that is not a real account", async () => {
    authUser = null;
    const res = await POST(
      req(
        event({ app_user_id: "99999999-9999-4999-8999-999999999999" }),
        `Bearer ${SECRET}`
      )
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(upserts).toHaveLength(0);
  });

  it("retries (500) when the account lookup itself fails", async () => {
    authError = { message: "connection reset" };
    const res = await POST(req(event(), `Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(upserts).toHaveLength(0);
  });
});

describe("RevenueCat webhook event mapping", () => {
  it("maps the handled event types to the same status values Stripe writes", async () => {
    const cases: Array<[string, string]> = [
      ["INITIAL_PURCHASE", "active"],
      ["RENEWAL", "active"],
      ["UNCANCELLATION", "active"],
      ["PRODUCT_CHANGE", "active"],
      ["CANCELLATION", "active"],
      ["EXPIRATION", "canceled"],
      ["BILLING_ISSUE", "past_due"],
    ];
    for (const [type, status] of cases) {
      upserts = [];
      const res = await POST(req(event({ type }), `Bearer ${SECRET}`));
      expect(res.status).toBe(200);
      expect(upserts, type).toHaveLength(1);
      expect(upserts[0].payload, type).toMatchObject({ status });
    }
  });

  it("writes trialing for a store-granted free trial", async () => {
    await POST(req(event({ period_type: "TRIAL" }), `Bearer ${SECRET}`));
    expect(upserts[0].payload).toMatchObject({ status: "trialing" });
  });

  it("writes nothing for TEST, TRANSFER or an unknown event type", async () => {
    for (const type of ["TEST", "TRANSFER", "SUBSCRIPTION_PAUSED", "SOMETHING_NEW"]) {
      upserts = [];
      const res = await POST(req(event({ type }), `Bearer ${SECRET}`));
      expect(res.status, type).toBe(200);
      expect(upserts, type).toHaveLength(0);
    }
  });

  it("writes nothing for an entitlement OakTend does not sell", async () => {
    const res = await POST(
      req(event({ entitlement_ids: ["some_other_thing"] }), `Bearer ${SECRET}`)
    );
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(0);
  });

  it("puts the pro entitlement on the pro side with a pro_ plan name", async () => {
    await POST(
      req(
        event({
          entitlement_ids: ["oaktend_pro"],
          product_id: "oaktend_pro_yearly",
        }),
        `Bearer ${SECRET}`
      )
    );
    expect(upserts[0].payload).toMatchObject({ side: "pro", plan: "pro_yearly" });
  });
});

describe("RevenueCat webhook sandbox handling", () => {
  it("refuses to grant on a SANDBOX event in production", async () => {
    const res = await POST(
      req(event({ environment: "SANDBOX" }), `Bearer ${SECRET}`)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(upserts).toHaveLength(0);
  });

  it("grants on a SANDBOX event when REVENUECAT_ALLOW_SANDBOX is set", async () => {
    process.env.REVENUECAT_ALLOW_SANDBOX = "1";
    vi.resetModules();
    ({ POST } = await import("./route"));
    const res = await POST(
      req(event({ environment: "SANDBOX" }), `Bearer ${SECRET}`)
    );
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(1);
  });
});

describe("RevenueCat webhook must not disturb a Stripe subscriber", () => {
  it("refuses to touch a side that a LIVE Stripe subscription manages", async () => {
    existingRow = {
      status: "active",
      plan: "monthly",
      current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      updated_at: new Date(AT - 86_400_000).toISOString(),
      stripe_subscription_id: "sub_live_123",
    };
    const res = await POST(
      req(event({ type: "EXPIRATION" }), `Bearer ${SECRET}`)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
    expect(upserts).toHaveLength(0);
  });

  it("never blanks out the Stripe ids on a row it does not own", async () => {
    // No stripe id on the row: the payload must not carry the two Stripe
    // columns at all, so a later Stripe write cannot be clobbered by an
    // implicit null from this route.
    const res = await POST(req(event(), `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(upserts[0].payload).not.toHaveProperty("stripe_subscription_id");
    expect(upserts[0].payload).not.toHaveProperty("stripe_customer_id");
  });

  it("clears the stale Stripe ids when it takes over a DEAD Stripe row", async () => {
    existingRow = {
      status: "canceled",
      plan: "monthly",
      current_period_end: new Date(AT - 86_400_000).toISOString(),
      updated_at: new Date(AT - 86_400_000).toISOString(),
      stripe_subscription_id: "sub_dead_123",
    };
    const res = await POST(req(event(), `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(upserts[0].payload).toMatchObject({
      stripe_subscription_id: null,
      stripe_customer_id: null,
      status: "active",
    });
  });

  it("retries (500) rather than writing blind when the existing-row read fails", async () => {
    readError = { message: "connection reset" };
    const res = await POST(req(event(), `Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(upserts).toHaveLength(0);
  });
});
