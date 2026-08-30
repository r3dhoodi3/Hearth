import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRIAL_PLAN_SWITCH_MESSAGE } from "@/lib/billingTerms";

// Drives the three plan-change server actions against a mocked Stripe client.
// The module is a "use server" file, so everything it pulls in that needs a
// real server (the service-role client, "server-only", next/navigation) is
// stubbed; the branching under test is the action's own.
//
// WHAT THESE PIN, and why. Live, on 2026-08-30, a weekly member seven minutes
// into their 3-day free trial tapped "Switch to monthly at renewal". The action
// handed the trialing subscription to a Stripe subscription schedule, the trial
// ended on the spot, and Stripe drafted a $1.99 invoice - while the button, the
// toast, and the auto-renewal disclosure the buyer consented to at checkout all
// said nothing would be charged before the free days were over. So: no
// invoice-creating Stripe call may happen for a trialing subscriber, and a
// schedule that would end a live trial must be released rather than updated.

vi.mock("server-only", () => ({}));

class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const redirect = vi.fn((url: string) => {
  throw new RedirectError(url);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const subsRetrieve = vi.fn();
const subsUpdate = vi.fn();
const schedulesCreate = vi.fn();
const schedulesUpdate = vi.fn();
const schedulesRelease = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: {
    subscriptions: {
      retrieve: (...a: unknown[]) => subsRetrieve(...a),
      update: (...a: unknown[]) => subsUpdate(...a),
      list: vi.fn(),
    },
    subscriptionSchedules: {
      create: (...a: unknown[]) => schedulesCreate(...a),
      update: (...a: unknown[]) => schedulesUpdate(...a),
      release: (...a: unknown[]) => schedulesRelease(...a),
    },
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
  },
}));

// Price resolution is exercised for real in src/lib/stripePlanPrice.test.ts;
// here it only has to be a stable id so the payloads are readable.
vi.mock("@/lib/stripePlanPrice", () => ({
  plusPriceId: vi.fn(async (c: string) => `price_plus_${c}`),
  homeSlotPriceId: vi.fn(async (i: string, q: number) => `price_slot_${i}_${q}`),
}));

const getSubscription = vi.fn();
vi.mock("@/lib/subscription", () => ({
  getSubscription: () => getSubscription(),
  getProSubscription: vi.fn(async () => null),
  isPlusTrialEligible: vi.fn(async () => false),
}));

vi.mock("@/lib/auth", () => ({ getUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/risk/signals", () => ({ recordRequestSignals: vi.fn() }));
vi.mock("@/lib/trackServer", () => ({ trackServerEvent: vi.fn() }));

const setFlash = vi.fn();
vi.mock("@/lib/flash", () => ({ setFlash: (...a: unknown[]) => setFlash(...a) }));

const { downgradeToMonthlyAction, keepYearlyAction, upgradeToYearlyAction } =
  await import("./actions");

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

function stripeSub(over: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    schedule: null,
    trial_end: null,
    items: {
      data: [
        {
          id: "si_base",
          quantity: 1,
          metadata: {},
          price: { id: "price_weekly", product: "prod_archived" },
        },
      ],
    },
    ...over,
  };
}

// Every Stripe call that can put money on an invoice. The trialing case must
// reach none of them.
function billingCalls(): number {
  return (
    subsUpdate.mock.calls.length +
    schedulesCreate.mock.calls.length +
    schedulesUpdate.mock.calls.length
  );
}

async function run(fn: () => Promise<void>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  getSubscription.mockResolvedValue({
    stripe_subscription_id: "sub_1",
    stripe_customer_id: "cus_1",
    plan: "weekly",
    status: "active",
  });
  subsRetrieve.mockResolvedValue(stripeSub());
  schedulesCreate.mockResolvedValue({
    id: "sched_1",
    phases: [
      {
        start_date: nowSec() - HOUR,
        end_date: nowSec() + 24 * HOUR,
        trial_end: null,
        items: [{ price: "price_weekly", quantity: 1 }],
      },
    ],
  });
  schedulesUpdate.mockResolvedValue({ id: "sched_1" });
  schedulesRelease.mockResolvedValue({ id: "sched_1" });
  subsUpdate.mockResolvedValue({ id: "sub_1" });
});

describe("switching to monthly during a free trial", () => {
  beforeEach(() => {
    getSubscription.mockResolvedValue({
      stripe_subscription_id: "sub_1",
      stripe_customer_id: "cus_1",
      plan: "weekly",
      status: "trialing",
    });
    subsRetrieve.mockResolvedValue(
      stripeSub({ status: "trialing", trial_end: nowSec() + 3 * 24 * HOUR })
    );
  });

  it("makes no billing call at all", async () => {
    const url = await run(downgradeToMonthlyAction);
    expect(billingCalls()).toBe(0);
    expect(url).toBe("/plus");
  });

  it("says when they can switch instead of failing silently", async () => {
    await run(downgradeToMonthlyAction);
    expect(setFlash).toHaveBeenCalledWith(TRIAL_PLAN_SWITCH_MESSAGE, "info");
  });

  it("refuses on Stripe's status, not on our stored row", async () => {
    // The row can lag the webhook. Stripe's own answer is what decides.
    getSubscription.mockResolvedValue({
      stripe_subscription_id: "sub_1",
      plan: "weekly",
      status: "active",
    });
    await run(downgradeToMonthlyAction);
    expect(schedulesCreate).not.toHaveBeenCalled();
  });
});

describe("a schedule that would end a live trial is backed out", () => {
  it("releases it and changes nothing when the phase still carries a trial", async () => {
    // Stripe says active, but the phase it generated is trialing until
    // tomorrow. Sending phases back without that trial_end is precisely what
    // ended the trial and drafted an invoice live, so back out entirely.
    schedulesCreate.mockResolvedValue({
      id: "sched_1",
      phases: [
        {
          start_date: nowSec() - HOUR,
          end_date: nowSec() + 24 * HOUR,
          trial_end: nowSec() + 12 * HOUR,
          items: [{ price: "price_weekly", quantity: 1 }],
        },
      ],
    });

    const url = await run(downgradeToMonthlyAction);

    expect(schedulesUpdate).not.toHaveBeenCalled();
    expect(schedulesRelease).toHaveBeenCalledWith("sched_1");
    expect(setFlash).toHaveBeenCalledWith(TRIAL_PLAN_SWITCH_MESSAGE, "info");
    expect(url).toBe("/plus");
  });

  it("proceeds when the phase's trial is already over", async () => {
    schedulesCreate.mockResolvedValue({
      id: "sched_1",
      phases: [
        {
          start_date: nowSec() - 5 * 24 * HOUR,
          end_date: nowSec() + 24 * HOUR,
          trial_end: nowSec() - 2 * 24 * HOUR,
          items: [{ price: "price_weekly", quantity: 1 }],
        },
      ],
    });
    await run(downgradeToMonthlyAction);
    expect(schedulesUpdate).toHaveBeenCalled();
  });
});

describe("switching to monthly outside a trial", () => {
  it("keeps the paid period whole and only switches the next phase", async () => {
    await run(downgradeToMonthlyAction);

    const [id, params] = schedulesUpdate.mock.calls[0];
    expect(id).toBe("sched_1");
    expect(params.proration_behavior).toBe("none");
    expect(params.end_behavior).toBe("release");

    const [phase1, phase2] = params.phases;
    // Phase 1 is the period they already paid for, unchanged and unpriced-over.
    expect(phase1.items).toEqual([{ price: "price_weekly", quantity: 1 }]);
    expect(phase1.end_date).toBeGreaterThan(nowSec());
    // Phase 2 is the only place the new price appears, and it starts when
    // phase 1 ends - so nothing bills before the current period is over.
    expect(phase2.items).toEqual([{ price: "price_plus_monthly", quantity: 1 }]);
    expect(phase2.proration_behavior).toBe("none");
    // And nothing touched the subscription itself, which is what would have
    // invoiced today.
    expect(subsUpdate).not.toHaveBeenCalled();
  });

  it("never sends a product id read off the subscription", async () => {
    await run(downgradeToMonthlyAction);
    const json = JSON.stringify(schedulesUpdate.mock.calls[0][1]);
    expect(json).not.toContain("prod_archived");
    expect(json).not.toContain("price_data");
  });

  it("carries the extra-home add-on into the monthly phase", async () => {
    subsRetrieve.mockResolvedValue(
      stripeSub({
        items: {
          data: [
            {
              id: "si_base",
              quantity: 1,
              metadata: {},
              price: { id: "price_weekly", product: "prod_archived" },
            },
            {
              id: "si_addon",
              quantity: 2,
              metadata: { hearth_addon: "home_slots" },
              price: { id: "price_slot_old", product: "prod_archived" },
            },
          ],
        },
      })
    );
    await run(downgradeToMonthlyAction);
    const [, params] = schedulesUpdate.mock.calls[0];
    expect(params.phases[1].items).toContainEqual({
      price: "price_slot_monthly_2",
      quantity: 2,
      metadata: { hearth_addon: "home_slots" },
    });
  });

  it("releases the schedule and reports a failed update instead of crashing", async () => {
    // A rethrow here used to land the member on the error page with a schedule
    // half-applied. The subscription is put back the way it was, so this is a
    // failed attempt, not a broken account.
    schedulesUpdate.mockRejectedValue(new Error("stripe down"));
    const url = await run(downgradeToMonthlyAction);
    expect(schedulesRelease).toHaveBeenCalledWith("sched_1");
    expect(url).toBe("/plus");
    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't schedule the switch. If your plan is set to cancel, use Manage billing instead.",
      "error"
    );
  });

  it("is refused outright when a schedule already exists", async () => {
    subsRetrieve.mockResolvedValue(stripeSub({ schedule: "sched_old" }));
    await run(downgradeToMonthlyAction);
    expect(billingCalls()).toBe(0);
  });
});

describe("keeping the current plan names the plan actually kept", () => {
  it.each([
    ["weekly", "You're keeping the weekly plan."],
    ["monthly", "You're keeping the monthly plan."],
    ["yearly", "You're keeping the yearly plan."],
  ])("%s", async (plan, message) => {
    getSubscription.mockResolvedValue({
      stripe_subscription_id: "sub_1",
      plan,
      status: "active",
    });
    subsRetrieve.mockResolvedValue(stripeSub({ schedule: "sched_1" }));
    await run(keepYearlyAction);
    expect(schedulesRelease).toHaveBeenCalledWith("sched_1");
    expect(setFlash).toHaveBeenCalledWith(message);
  });

  it("names no cadence when the stored plan is unknown", async () => {
    getSubscription.mockResolvedValue({
      stripe_subscription_id: "sub_1",
      plan: null,
      status: "active",
    });
    subsRetrieve.mockResolvedValue(stripeSub({ schedule: "sched_1" }));
    await run(keepYearlyAction);
    expect(setFlash).toHaveBeenCalledWith("You're keeping your current plan.");
  });
});

describe("switching to yearly", () => {
  it("bills a resolved active Price, not the subscription's own product", async () => {
    await run(upgradeToYearlyAction);
    const [id, params] = subsUpdate.mock.calls[0];
    expect(id).toBe("sub_1");
    expect(params.items).toEqual([
      { id: "si_base", price: "price_plus_yearly", quantity: 1 },
    ]);
    expect(JSON.stringify(params)).not.toContain("prod_archived");
    expect(params.proration_behavior).toBe("always_invoice");
  });

  it("converts a monthly add-on to the yearly tier in the same update", async () => {
    subsRetrieve.mockResolvedValue(
      stripeSub({
        items: {
          data: [
            {
              id: "si_base",
              quantity: 1,
              metadata: {},
              price: { id: "price_monthly", product: "prod_archived" },
            },
            {
              id: "si_addon",
              quantity: 3,
              metadata: { hearth_addon: "home_slots" },
              price: { id: "price_slot_old", product: "prod_archived" },
            },
          ],
        },
      })
    );
    await run(upgradeToYearlyAction);
    expect(subsUpdate.mock.calls[0][1].items).toContainEqual({
      id: "si_addon",
      price: "price_slot_yearly_3",
      quantity: 3,
      metadata: { hearth_addon: "home_slots" },
    });
  });

  it("shows the Stripe fallback flash rather than throwing when the update fails", async () => {
    subsUpdate.mockRejectedValue(new Error("stripe down"));
    const url = await run(upgradeToYearlyAction);
    expect(url).toBe("/plus");
    expect(setFlash).toHaveBeenCalledWith(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
  });
});
