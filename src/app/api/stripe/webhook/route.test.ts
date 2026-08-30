import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { sendNotification } from "@/lib/notify";
import { flagAbuse } from "@/lib/risk/signals";
import { billingTerms } from "@/lib/billingTerms";
import { PLUS_PLAN, PRO_PLAN, formatUsd } from "@/lib/constants";

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
// The mocked notifier, typed, so the dunning tests can read what the route
// actually asked to be sent.
const notify = vi.mocked(sendNotification);
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

// Every .from(table).update(payload) the route fires, so a test can assert the
// plan name actually written to the subscriptions row.
let tableUpdates: { table: string; payload: Record<string, unknown> }[] = [];

// Every .from(table).insert(payload) the route fires, so the checkout_started/
// completed/abandoned analytics tests below can assert the exact row written
// to app_events (via trackServerEvent, src/lib/trackServer.ts) without also
// having to distinguish it from every other insert the route makes.
let tableInserts: { table: string; payload: Record<string, unknown> }[] = [];

// What .from("subscriptions")...maybeSingle() reads back. Null by default,
// which is every pre-existing test's "no stored row" path; the dunning tests
// below set it so the route has a membership to act on.
let subscriptionRow: Record<string, unknown> | null = null;

// What .from("contractors")...maybeSingle() reads back. Null by default; the
// deposit-chargeback test (CRIT-29) sets it so flagDepositChargeback can map a
// deposit session's contractor_id to the account it should freeze.
let contractorRow: Record<string, unknown> | null = null;

// What .from("notifications")...maybeSingle() reads back, i.e. whether the dup
// guard finds a notice already sent for this key.
let existingNotification: Record<string, unknown> | null = null;

// Every .in(column, values) applied after an .update(), so a test can assert
// the status write is SCOPED rather than unconditional.
let updateFilters: { column: string; values: unknown[] }[] = [];

// The thin slice of the PostgREST builder this route uses on the deposit path:
// .from(...).select(...).eq(...).maybeSingle(). Everything reads back empty,
// which is the "no Pro boost" path - the deposit itself still applies.
function fakeAdmin() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: chain,
        eq: chain,
        like: chain,
        limit: chain,
        order: chain,
        // Awaiting the builder itself (the update path does) yields this
        // object, whose `error` is undefined - i.e. a successful write.
        in: (column: string, values: unknown[]) => {
          updateFilters.push({ column, values });
          return api;
        },
        // Recorded the same way `in` is, so a test can assert which statuses a
        // write was scoped away from. The subscription.updated branch uses this
        // to refuse to walk a canceled row back to active.
        neq: (column: string, value: unknown) => {
          updateFilters.push({ column, values: ["!=", value] });
          return api;
        },
        maybeSingle: () => {
          if (table === "subscriptions") {
            return Promise.resolve({ data: subscriptionRow, error: null });
          }
          if (table === "notifications") {
            return Promise.resolve({ data: existingNotification, error: null });
          }
          if (table === "contractors") {
            return Promise.resolve({ data: contractorRow, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert: (payload: Record<string, unknown>) => {
          tableInserts.push({ table, payload });
          return Promise.resolve({ data: null, error: null });
        },
        upsert: () => Promise.resolve({ data: null, error: null }),
        update: (payload: Record<string, unknown>) => {
          tableUpdates.push({ table, payload });
          return api;
        },
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
  tableUpdates = [];
  tableInserts = [];
  updateFilters = [];
  subscriptionRow = null;
  contractorRow = null;
  existingNotification = null;
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

  // docs/ANALYTICS.md: deposit_made fires only on the call that actually
  // credited the wallet, and carries a bucketed amount (nearest $250, rounded
  // up), never the exact cents Stripe charged.
  it("records deposit_made with a bucketed amount on a real credit", async () => {
    constructEvent.mockReturnValue(
      depositEvent({
        id: "cs_test_5",
        payment_status: "paid",
        amount_total: 50_000,
        metadata: { type: "deposit", contractor_id: "con_1", deposit_cents: "50000" },
      })
    );
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const tracked = tableInserts.find(
      (i) => i.table === "app_events" && i.payload.event === "deposit_made"
    );
    expect(tracked?.payload).toMatchObject({
      event: "deposit_made",
      props: { amount_bucket: 500 },
    });
    expect(Object.keys(tracked!.payload.props as object)).toEqual([
      "amount_bucket",
    ]);
  });

  it("never fires deposit_made for a refused, out-of-band amount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    constructEvent.mockReturnValue(
      depositEvent({
        id: "cs_test_6",
        payment_status: "paid",
        amount_total: 300_000, // over MAX_DEPOSIT_CENTS
        metadata: { type: "deposit", contractor_id: "con_1", deposit_cents: "300000" },
      })
    );
    const { POST } = await import("./route");

    await POST(post());

    expect(
      tableInserts.some(
        (i) => i.table === "app_events" && i.payload.event === "deposit_made"
      )
    ).toBe(false);
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

// ===========================================================================
// CRIT-29: a deposit chargeback must FREEZE the account, not just try to claw
// back cash that is usually already spent.
// ===========================================================================
// A wallet deposit is a mode:"payment" Checkout Session with no Stripe
// customer, so the PaymentIntent behind a disputed deposit has customer=null
// and flagChargebackForCharge (which resolves through the customer) flags
// nobody. flagDepositChargeback closes that by resolving the deposit session's
// contractor_id to the owning account and raising the same sticky
// abuse_flags/chargeback row has_open_chargeback() reads.
describe("a deposit chargeback freezes the contractor's account", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    vi.mocked(flagAbuse).mockClear();
  });

  function disputeCreated(paymentIntent = "pi_dep") {
    return {
      id: "evt_dispute_1",
      type: "charge.dispute.created",
      data: {
        object: { id: "dp_1", payment_intent: paymentIntent, amount: 50_000 },
      },
    };
  }

  it("flags the account behind the disputed deposit as a chargeback", async () => {
    // The deposit session the payment_intent resolves back to, and the account
    // that owns the contractor on it.
    depositSessions = [
      {
        id: "cs_dep",
        amount_total: 50_000,
        metadata: { type: "deposit", contractor_id: "con_9", deposit_cents: "50000" },
      },
    ];
    contractorRow = { user_id: "user_9" };
    constructEvent.mockReturnValue(disputeCreated());
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    // The freeze: abuse_flags row of kind 'chargeback' for the owning account,
    // which is exactly what has_open_chargeback() reads to refuse spending.
    const flagged = vi
      .mocked(flagAbuse)
      .mock.calls.find((c) => c[0] === "user_9" && c[1] === "chargeback");
    expect(flagged).toBeTruthy();
    expect(String(flagged?.[2])).toContain("wallet deposit");
  });

  it("does not flag when the charge is not a wallet deposit", async () => {
    // No deposit session resolves back (not a deposit charge): the deposit
    // freeze path stays quiet and leaves it to the membership/customer path.
    depositSessions = [];
    contractorRow = { user_id: "user_9" };
    constructEvent.mockReturnValue(disputeCreated("pi_not_a_deposit"));
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const depositFlag = vi
      .mocked(flagAbuse)
      .mock.calls.find((c) => String(c[2]).includes("wallet deposit"));
    expect(depositFlag).toBeUndefined();
  });
});

// Hearth Plus sells three cadences, so the plan the webhook stores has to be
// derived from all three Stripe intervals. Weekly is the newest, and it is the
// one that carries the free trial, so a subscription that renews every week
// must never be recorded as a monthly (or unknown) plan: /plus's cadence copy,
// the renewal-reminder cron's per-cadence windows, and the extra-homes gate all
// read subscriptions.plan.
describe("the stored plan follows the billing interval, weekly included", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  function subUpdatedEvent(interval: string | null) {
    return {
      id: "evt_sub_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test_1",
          status: "active",
          current_period_end: 1893456000,
          items: {
            data: [
              {
                id: "si_1",
                quantity: 1,
                metadata: {},
                price: {
                  id: "price_base",
                  recurring: interval ? { interval } : null,
                },
              },
            ],
          },
        },
      },
    };
  }

  async function planWrittenFor(interval: string | null) {
    // Cleared per call, not just per test, so a test can drive several
    // intervals through the route and read each write on its own.
    tableUpdates = [];
    constructEvent.mockReturnValue(subUpdatedEvent(interval));
    const { POST } = await import("./route");
    await POST(post());
    const write = tableUpdates.find((u) => u.table === "subscriptions");
    return write?.payload.plan;
  }

  it("stores weekly for a week interval", async () => {
    expect(await planWrittenFor("week")).toBe("weekly");
  });

  it("still stores monthly and yearly for the other two", async () => {
    expect(await planWrittenFor("month")).toBe("monthly");
    expect(await planWrittenFor("year")).toBe("yearly");
  });

  it("leaves the stored plan alone when no interval is readable", async () => {
    // Only overwrite the plan when the payload carries items we can read: a
    // partial event must not blank out a live member's cadence.
    expect(await planWrittenFor(null)).toBeUndefined();
  });
});

// ===========================================================================
// DUNNING
// ===========================================================================
// Before these two events were handled, a subscriber whose card started
// failing looked identical in-app to a happy one until
// customer.subscription.deleted finally fired - across a full Smart Retry
// window, up to a month later. Nobody was told: not the member, not the owner.

describe("invoice.payment_failed flags the membership and warns the member", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    notify.mockClear();
  });

  function failedInvoice(
    over: Record<string, unknown> = {},
    eventId = "evt_fail_1"
  ) {
    return {
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_test_1",
          subscription: "sub_test_1",
          billing_reason: "subscription_cycle",
          ...over,
        },
      },
    };
  }

  async function run(event: Record<string, unknown>) {
    constructEvent.mockReturnValue(event);
    const { POST } = await import("./route");
    return POST(post());
  }

  it("marks the subscriptions row past_due", async () => {
    subscriptionRow = { user_id: "u_1", plan: "monthly", status: "active" };
    const res = await run(failedInvoice());

    expect(res.status).toBe(200);
    const write = tableUpdates.find((u) => u.table === "subscriptions");
    expect(write?.payload.status).toBe("past_due");
  });

  it("scopes that write so a late event cannot un-cancel or un-recover a row", async () => {
    // Stripe does not guarantee event ordering, and
    // customer.subscription.updated is the authority on status - it also fires
    // for this failure and sets the row back to active the moment a retry
    // succeeds. An UNSCOPED past_due write would walk a canceled row backwards
    // or overwrite a recovery that already landed.
    subscriptionRow = { user_id: "u_1", plan: "monthly", status: "active" };
    await run(failedInvoice());

    const statusFilter = updateFilters.find((f) => f.column === "status");
    expect(statusFilter?.values).toEqual(["active", "trialing"]);
  });

  it("sends one notice pointing at the page that opens the billing portal", async () => {
    subscriptionRow = { user_id: "u_1", plan: "monthly", status: "active" };
    await run(failedInvoice());

    expect(notify).toHaveBeenCalledTimes(1);
    const sent = notify.mock.calls[0][1] as Record<string, any>;
    expect(sent.userId).toBe("u_1");
    expect(sent.kind).toBe("payment_failed");
    expect(sent.title).toBe(
      "Your Hearth Plus payment didn't go through, update your card"
    );
    // /plus is where manageBillingAction (the Stripe Customer Portal session)
    // lives; there is no standalone portal route in this app.
    expect(sent.url.startsWith("/plus?")).toBe(true);
    // A billing warning is never an SMS.
    expect(sent.phone).toBeNull();
  });

  it("keys the notice on the INVOICE, so Smart Retries do not spam", async () => {
    // Stripe fires invoice.payment_failed once per retry attempt over a
    // multi-week window - each with a NEW event id but the SAME invoice id.
    // Keying on the event id would send four copies of the same bad news.
    subscriptionRow = { user_id: "u_1", plan: "monthly", status: "active" };
    await run(failedInvoice());
    const firstUrl = (notify.mock.calls[0][1] as Record<string, any>).url;
    expect(firstUrl).toContain("invoice=in_test_1");

    // Second retry, different event id, same invoice: the dup guard now finds
    // the row the first one wrote.
    notify.mockClear();
    existingNotification = { id: "n_1" };
    await run(failedInvoice({}, "evt_fail_2"));
    expect(notify).not.toHaveBeenCalled();
  });

  it("is idempotent on a duplicate delivery of the very same event id", async () => {
    subscriptionRow = { user_id: "u_1", plan: "monthly", status: "active" };
    await run(failedInvoice());
    expect(notify).toHaveBeenCalledTimes(1);

    notify.mockClear();
    existingNotification = { id: "n_1" };
    await run(failedInvoice());
    expect(notify).not.toHaveBeenCalled();
  });

  it("names the right product for a contractor membership", async () => {
    subscriptionRow = { user_id: "u_2", plan: "pro_monthly", status: "active" };
    await run(failedInvoice());

    const sent = notify.mock.calls[0][1] as Record<string, any>;
    expect(sent.title).toContain("Hearth Pro");
    expect(sent.url.startsWith("/pro/plus?")).toBe(true);
  });

  it("does nothing at all for a one-off invoice with no subscription", async () => {
    subscriptionRow = { user_id: "u_1", plan: "monthly", status: "active" };
    const res = await run(failedInvoice({ subscription: null, parent: null }));

    expect(res.status).toBe(200);
    expect(tableUpdates.filter((u) => u.table === "subscriptions")).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("still 200s when there is no stored row to flag", async () => {
    // An unknown subscription must never fail the webhook: a non-2xx makes
    // Stripe redeliver the whole event, re-running every money handler beside
    // this one.
    subscriptionRow = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await run(failedInvoice());

    expect(res.status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it("still flags past_due when the plan name is unreadable, but stays quiet", async () => {
    // A notice quoting the wrong product or price is worse than no notice;
    // the internal flag has no such problem.
    subscriptionRow = { user_id: "u_1", plan: "legacy_thing", status: "active" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(failedInvoice());

    expect(
      tableUpdates.find((u) => u.table === "subscriptions")?.payload.status
    ).toBe("past_due");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("customer.subscription.trial_will_end quotes the real price", () => {
  // Trial end is 2027-01-01T00:00:00Z.
  const TRIAL_END_SEC = Date.UTC(2027, 0, 1) / 1000;

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    notify.mockClear();
  });

  function trialEvent(over: Record<string, unknown> = {}) {
    return {
      id: "evt_trial_1",
      type: "customer.subscription.trial_will_end",
      data: {
        object: {
          id: "sub_test_1",
          status: "trialing",
          trial_end: TRIAL_END_SEC,
          items: {
            data: [
              {
                id: "si_1",
                quantity: 1,
                metadata: {},
                price: { id: "price_base", recurring: { interval: "week" } },
              },
            ],
          },
          ...over,
        },
      },
    };
  }

  async function run(event: Record<string, unknown>) {
    constructEvent.mockReturnValue(event);
    const { POST } = await import("./route");
    return POST(post());
  }

  it("states the price that will actually be charged, read from constants", async () => {
    // THE POINT. Nothing here writes a dollar figure by hand: the sentence is
    // billingTerms', which derives it from PLUS_PLAN, so a price edit in
    // src/lib/constants.ts moves this notice with it and the two can never
    // quote different numbers to the same person.
    subscriptionRow = { user_id: "u_1", plan: "weekly" };
    await run(trialEvent());

    expect(notify).toHaveBeenCalledTimes(1);
    const sent = notify.mock.calls[0][1] as Record<string, any>;
    const terms = billingTerms("weekly", true);
    expect(sent.body).toContain(formatUsd(PLUS_PLAN.weekly));
    expect(sent.body).toBe(`${terms.recurring} ${terms.cancel}`);
  });

  it("uses the Pro price for a contractor trial", async () => {
    subscriptionRow = { user_id: "u_2", plan: "pro_monthly" };
    await run(trialEvent());

    const sent = notify.mock.calls[0][1] as Record<string, any>;
    expect(sent.body).toContain(formatUsd(PRO_PLAN.monthly));
    expect(sent.title).toContain("Hearth Pro");
  });

  it("names the date the trial ends", async () => {
    subscriptionRow = { user_id: "u_1", plan: "weekly" };
    await run(trialEvent());

    const sent = notify.mock.calls[0][1] as Record<string, any>;
    expect(sent.title).toBe("Your Hearth Plus free trial ends on January 1, 2027");
  });

  it("shares its dup key with the renewal-reminders cron", async () => {
    // The cron's case-1 trial notice writes kind "renewal_reminder" at
    // `${cancelPath}?renewal=<trial end date>`. Matching both means a member
    // hears about the ending trial exactly once, from whichever path got there
    // first, instead of twice in slightly different words.
    subscriptionRow = { user_id: "u_1", plan: "weekly" };
    await run(trialEvent());

    const sent = notify.mock.calls[0][1] as Record<string, any>;
    expect(sent.kind).toBe("renewal_reminder");
    expect(sent.url).toBe("/plus?renewal=2027-01-01");
  });

  it("is idempotent on a duplicate delivery", async () => {
    subscriptionRow = { user_id: "u_1", plan: "weekly" };
    existingNotification = { id: "n_1" };
    await run(trialEvent());
    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing when the event carries no trial end date", async () => {
    subscriptionRow = { user_id: "u_1", plan: "weekly" };
    const res = await run(trialEvent({ trial_end: null }));

    expect(res.status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });

  it("never 500s when there is no stored row", async () => {
    subscriptionRow = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run(trialEvent())).status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("a completed checkout marks the promo claim spent", () => {
  // Why this matters: the checkout actions now read promo_claims.ref to tell an
  // abandoned reservation (give the trial back) apart from a spent one (never
  // again). claim_promo's "on conflict do nothing" cannot update that ref, so
  // without this stamp a converted account could reclaim its own used trial.
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  function completedPlusSession() {
    return {
      id: "evt_plus_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_plus_1",
          payment_status: "paid",
          customer: "cus_1",
          subscription: "sub_1",
          metadata: {
            type: "plus_subscription",
            user_id: "user_1",
            plan: "weekly",
            trial_reserved: "true",
          },
        },
      },
    };
  }

  it("stamps converted:<subscription id> on the Plus trial claim", async () => {
    const { stripe } = await import("@/lib/stripe");
    (stripe.subscriptions.retrieve as any).mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      items: { data: [{ price: { recurring: { interval: "week" } } }] },
    });
    constructEvent.mockReturnValue(completedPlusSession());
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const stamp = tableUpdates.find((u) => u.table === "promo_claims");
    expect(stamp?.payload.ref).toBe("converted:sub_1");
  });

  // docs/ANALYTICS.md: checkout_completed is the trustworthy funnel signal
  // for a Plus purchase (not the ?welcome=1 page render, which can beat or
  // lose the race with this webhook). Asserts the exact row trackServerEvent
  // writes to app_events: the right event name, the right user, and a
  // payload that carries only the plan enum, never free text.
  it("records checkout_completed with the plan, no free text", async () => {
    const { stripe } = await import("@/lib/stripe");
    (stripe.subscriptions.retrieve as any).mockResolvedValue({
      id: "sub_1",
      status: "trialing",
      items: { data: [{ price: { recurring: { interval: "week" } } }] },
    });
    constructEvent.mockReturnValue(completedPlusSession());
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const tracked = tableInserts.find((i) => i.table === "app_events");
    expect(tracked?.payload).toMatchObject({
      event: "checkout_completed",
      user_id: "user_1",
      props: { plan: "weekly" },
    });
    // Only an id and an enum plan name - never a name, email, or anything a
    // buyer typed into the checkout flow.
    expect(Object.keys(tracked!.payload.props as object)).toEqual(["plan"]);
  });

  function completedProSession() {
    return {
      id: "evt_pro_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pro_1",
          payment_status: "paid",
          customer: "cus_3",
          subscription: "sub_pro_1",
          metadata: {
            type: "pro_subscription",
            user_id: "user_4",
            plan: "pro_monthly",
            intro_reserved: "false",
          },
        },
      },
    };
  }

  // docs/ANALYTICS.md: pro_checkout_completed mirrors the homeowner
  // checkout_completed event above - fired off the webhook (the trustworthy
  // completion signal), never the ?welcome=1 page render.
  it("records pro_checkout_completed with the plan, no free text", async () => {
    const { stripe } = await import("@/lib/stripe");
    (stripe.subscriptions.retrieve as any).mockResolvedValue({
      id: "sub_pro_1",
      status: "active",
      items: { data: [{ price: { recurring: { interval: "month" } } }] },
    });
    constructEvent.mockReturnValue(completedProSession());
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const tracked = tableInserts.find(
      (i) =>
        i.table === "app_events" &&
        i.payload.event === "pro_checkout_completed"
    );
    expect(tracked?.payload).toMatchObject({
      event: "pro_checkout_completed",
      user_id: "user_4",
      props: { plan: "pro_monthly" },
    });
    expect(Object.keys(tracked!.payload.props as object)).toEqual(["plan"]);
  });

  // HIGH-31: a completed Pro checkout stamps BOTH promo reservations spent -
  // the retired intro coupon AND the free trial - so a later checkout can never
  // reclaim either and hand out a second one. Before the pro_trial reservation
  // existed, only the intro claim was stamped; now there are two conversion
  // writes, both carrying converted:<subscription id>.
  it("stamps the pro_trial reservation converted alongside the intro one", async () => {
    const { stripe } = await import("@/lib/stripe");
    (stripe.subscriptions.retrieve as any).mockResolvedValue({
      id: "sub_pro_1",
      status: "active",
      items: { data: [{ price: { recurring: { interval: "month" } } }] },
    });
    constructEvent.mockReturnValue(completedProSession());
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const converts = tableUpdates.filter(
      (u) => u.table === "promo_claims" && u.payload.ref === "converted:sub_pro_1"
    );
    // Two: pro_intro_monthly and pro_trial. The pro_trial stamp is the new one.
    expect(converts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("an expired Plus checkout records checkout_abandoned", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  function expiredPlusSession() {
    return {
      id: "evt_plus_expired_1",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_plus_2",
          customer: "cus_1",
          metadata: {
            type: "plus_subscription",
            user_id: "user_2",
            plan: "monthly",
            trial_reserved: "false",
          },
        },
      },
    };
  }

  it("fires checkout_abandoned with the plan from metadata", async () => {
    constructEvent.mockReturnValue(expiredPlusSession());
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const tracked = tableInserts.find((i) => i.table === "app_events");
    expect(tracked?.payload).toMatchObject({
      event: "checkout_abandoned",
      user_id: "user_2",
      props: { plan: "monthly" },
    });
  });

  // docs/ANALYTICS.md: pro_checkout_abandoned mirrors checkout_abandoned
  // above for the Pro side, so the funnel has a symmetric abandon signal on
  // both memberships.
  it("fires pro_checkout_abandoned for a Pro checkout session expiring", async () => {
    constructEvent.mockReturnValue({
      id: "evt_pro_expired_1",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_pro_1",
          customer: "cus_2",
          metadata: {
            type: "pro_subscription",
            user_id: "user_3",
            plan: "pro_yearly",
            intro_reserved: "false",
          },
        },
      },
    });
    const { POST } = await import("./route");

    const res = await POST(post());

    expect(res.status).toBe(200);
    const tracked = tableInserts.find(
      (i) =>
        i.table === "app_events" &&
        i.payload.event === "pro_checkout_abandoned"
    );
    expect(tracked?.payload).toMatchObject({
      event: "pro_checkout_abandoned",
      user_id: "user_3",
      props: { plan: "pro_yearly" },
    });
  });
});
