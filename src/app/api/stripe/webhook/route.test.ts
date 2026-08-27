import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// The route pulls in the service-role client, the Stripe client, the notifier
// and the risk modules, all of which import "server-only" and are unresolvable
// under vitest. Mocked with factories, so none of them is ever executed - which
// is also what lets the route itself be imported and driven for real.

const constructEvent = vi.fn();

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: (...args: unknown[]) => constructEvent(...args),
    },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    checkout: { sessions: { list: async () => ({ data: depositSessions }) } },
    invoicePayments: { list: vi.fn(async () => ({ data: [] })) },
    invoices: { retrieve: vi.fn() },
    paymentMethods: { retrieve: vi.fn() },
    setupIntents: { retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin(),
}));

vi.mock("@/lib/notify", () => ({ sendNotification: vi.fn(async () => true) }));
vi.mock("@/lib/subscription", () => ({ isLiveProPlanRow: () => false }));
vi.mock("@/lib/risk/signals", () => ({
  recordCardSignal: vi.fn(async () => {}),
  flagAbuse: vi.fn(async () => {}),
}));
vi.mock("@/lib/risk/facts", () => ({
  computeRisk: vi.fn(async () => ({ score: 0, level: "low", reasons: [] })),
}));
vi.mock("@/lib/risk/decision", () => ({ riskEnforcementEnabled: () => false }));

// Every RPC the route fires, in order, so a test can assert what the ledger was
// actually asked to do (and, more importantly, what it was NOT asked to do).
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

// What stripe.checkout.sessions.list answers, i.e. the deposit session a
// dispute or refund resolves back to.
let depositSessions: Record<string, unknown>[] = [];

// The thin slice of the PostgREST builder this route uses on the deposit path:
// .from(...).select(...).eq(...).maybeSingle(). Everything reads back empty,
// which is the "no Pro boost" path - the deposit itself still applies.
function fakeAdmin() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: chain,
        eq: chain,
        like: chain,
        limit: chain,
        order: chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        upsert: () => Promise.resolve({ data: null, error: null }),
        update: chain,
        delete: chain,
      });
      return api;
    },
  };
}

// The route only ever reads .text() and one header off the request.
function post(body = "{}", signature = "t=1,v1=deadbeef") {
  return {
    text: async () => body,
    headers: { get: (key: string) => (key === "stripe-signature" ? signature : null) },
  } as unknown as NextRequest;
}

function depositEvent(session: Record<string, unknown>) {
  return {
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: { object: session },
  };
}

const ORIGINAL_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

beforeEach(() => {
  rpcCalls = [];
  depositSessions = [];
  constructEvent.mockReset();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = ORIGINAL_SECRET;
  vi.restoreAllMocks();
});

describe("the webhook fails CLOSED without a signing secret", () => {
  it("refuses before constructEvent when STRIPE_WEBHOOK_SECRET is missing", async () => {
    // THE BUG THIS GUARDS. stripe-node does not object to an empty signing
    // secret: it computes HMAC-SHA256 keyed by the empty string and compares.
    // Anyone can compute that, so an unconfigured deployment did not reject
    // forged webhooks, it accepted them - and every money path below runs on
    // whatever JSON arrived.
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Webhook not configured");
    // The point of the fix: verification is never even attempted.
    expect(constructEvent).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it("treats an empty-string secret the same as a missing one", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(500);
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("500, not 400, so Stripe redelivers once the secret is set", async () => {
    // A 4xx tells Stripe the event is permanently rejected and real events are
    // lost. A 5xx keeps them queued.
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");
    expect((await POST(post())).status).not.toBe(400);
  });

  it("still rejects a bad signature with 400 when the secret IS set", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    constructEvent.mockImplementation(() => {
      throw new Error("no signatures found matching the expected signature");
    });
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(400);
    expect(constructEvent).toHaveBeenCalledTimes(1);
    // And it verified against the real secret, not the empty string.
    expect(constructEvent.mock.calls[0][2]).toBe("whsec_test");
  });
});

describe("a deposit credits what Stripe charged, not what metadata claims", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  function applyDeposit() {
    return rpcCalls.filter((c) => c.fn === "apply_deposit");
  }

  it("uses amount_total even when metadata says something else", async () => {
    constructEvent.mockReturnValue(
      depositEvent({
        id: "cs_test_1",
        payment_status: "paid",
        amount_total: 50_000,
        metadata: {
          type: "deposit",
          contractor_id: "con_1",
          // The number that used to decide the credit.
          deposit_cents: "20000000",
        },
      })
    );
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const calls = applyDeposit();
    expect(calls.length).toBe(1);
    expect(calls[0].args.p_deposit_cents).toBe(50_000);
    // Metadata still says WHICH contractor, just not how much.
    expect(calls[0].args.p_contractor).toBe("con_1");
  });

  it("refuses an amount over the shared deposit cap, without retrying", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    constructEvent.mockReturnValue(
      depositEvent({
        id: "cs_test_2",
        payment_status: "paid",
        amount_total: 300_000, // over MAX_DEPOSIT_CENTS
        metadata: { type: "deposit", contractor_id: "con_1", deposit_cents: "300000" },
      })
    );
    const { POST } = await import("./route");

    const res = await POST(post());

    // 200: a redelivery would carry the same out-of-band amount, so asking
    // Stripe to retry would only loop forever.
    expect(res.status).toBe(200);
    expect(applyDeposit()).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it("refuses a zero, missing or negative amount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");

    for (const amount of [0, -100, null, undefined, "lots"]) {
      rpcCalls = [];
      constructEvent.mockReturnValue(
        depositEvent({
          id: "cs_test_3",
          payment_status: "paid",
          amount_total: amount,
          metadata: {
            type: "deposit",
            contractor_id: "con_1",
            deposit_cents: "150000",
          },
        })
      );
      const res = await POST(post());
      expect(res.status).toBe(200);
      expect(applyDeposit()).toEqual([]);
    }
  });

  it("reverses nothing when the session was never credited in the first place", async () => {
    // THE ASYMMETRY THIS GUARDS. The credit path REFUSES an over-cap session,
    // so nothing ever landed in the wallet. If the reversal path clamped the
    // same amount down to the cap instead of refusing it, a refund on that
    // never-credited session would debit $2,000 of money the pro had put there
    // legitimately. Both ends now read the one predicate.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    depositSessions = [
      {
        id: "cs_over",
        amount_total: 300_000, // over MAX_DEPOSIT_CENTS: never credited
        metadata: { type: "deposit", contractor_id: "con_1", deposit_cents: "300000" },
      },
    ];
    constructEvent.mockReturnValue({
      id: "evt_refund_1",
      type: "charge.refunded",
      data: {
        object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 300_000 },
      },
    });
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const reversal = rpcCalls.filter((c) => c.fn === "reverse_deposit");
    expect(reversal.length).toBe(1);
    // The cap the RPC reverses up to is 0, so it debits nothing.
    expect(reversal[0].args.p_deposit_cents).toBe(0);
    expect(logged).toHaveBeenCalled();
  });

  it("reverses up to what Stripe actually charged on a normal deposit", async () => {
    depositSessions = [
      {
        id: "cs_ok",
        amount_total: 50_000,
        // Metadata claiming more must not widen the clawback either.
        metadata: { type: "deposit", contractor_id: "con_1", deposit_cents: "20000000" },
      },
    ];
    constructEvent.mockReturnValue({
      id: "evt_refund_2",
      type: "charge.refunded",
      data: {
        object: { id: "ch_2", payment_intent: "pi_2", amount_refunded: 50_000 },
      },
    });
    const { POST } = await import("./route");

    await POST(post());

    const reversal = rpcCalls.filter((c) => c.fn === "reverse_deposit");
    expect(reversal.length).toBe(1);
    expect(reversal[0].args.p_deposit_cents).toBe(50_000);
    expect(reversal[0].args.p_reported_cents).toBe(50_000);
  });

  it("still credits nothing until the money has actually settled", async () => {
    // Unchanged behaviour, restated here because the amount now comes from the
    // session: an ACH debit completes "unpaid" and settles later.
    constructEvent.mockReturnValue(
      depositEvent({
        id: "cs_test_4",
        payment_status: "unpaid",
        amount_total: 50_000,
        metadata: { type: "deposit", contractor_id: "con_1", deposit_cents: "50000" },
      })
    );
    const { POST } = await import("./route");

    await POST(post());

    expect(applyDeposit()).toEqual([]);
  });
});
