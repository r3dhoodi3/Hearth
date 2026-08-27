import { beforeEach, describe, it, expect, vi } from "vitest";

// Same trick src/lib/aiUsage.test.ts uses: mocking the service-role client out
// means "server-only" is never pulled in, so countAiUsage can be driven for
// real against a fake counter instead of being asserted at the level of source
// text.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

let currentAdmin: unknown = null;

import { AI_GLOBAL_BUCKET } from "./constants";

type Bucket = { limit: number; allowed: boolean };

type Fake = {
  // What rate_limit_hit answers, per bucket name. Anything not listed is
  // allowed.
  buckets: Record<string, Bucket>;
  // Every rate_limit_hit call, in order, so a test can assert which ceilings
  // were consulted at all.
  hits: string[];
  // The user's ai_usage row: what bump_ai_usage returns, and what a refund
  // decrements.
  used: number;
  bumps: number;
  // What the subscriptions table holds for this user. Empty is a free account.
  // A "trialing" row is what hasPlus() calls Plus and what the daily breaker
  // must NOT exempt.
  subscriptions: { status: string; current_period_end?: string | null }[];
  // How many times the exemption lookup ran, so a test can prove it does not
  // fire on the normal path.
  subscriptionReads: number;
};

// The slice of the client aiUsage actually uses: .rpc() for the counters, and
// the .from("ai_usage") read-modify-write the refund walks.
function fakeAdmin(state: Fake) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "bump_ai_usage") {
        state.bumps += 1;
        state.used += Number(args.p_delta ?? 1);
        return Promise.resolve({ data: state.used, error: null });
      }
      if (fn === "rate_limit_hit") {
        const bucket = String(args.p_bucket);
        state.hits.push(bucket);
        // The chat's daily bucket IS the charge: rate_limit_hit counts as it
        // checks, so a call to it is a question spent. Modelled on the same
        // `used` counter the tool path's bump_ai_usage moves, so a refund is
        // observable either way.
        if (bucket.startsWith("ask-day:")) {
          state.bumps += 1;
          state.used += 1;
        }
        const configured = state.buckets[bucket];
        return Promise.resolve({
          data: configured ? configured.allowed : true,
          error: null,
        });
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from(table: string) {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      let patch: Record<string, unknown> | null = null;
      Object.assign(api, {
        select: (_cols?: string) => {
          if (patch) {
            const next = Number(patch.count);
            state.used = next;
            return Promise.resolve({ data: [{ count: next }], error: null });
          }
          return api;
        },
        // The subscriptions read has no .maybeSingle() terminal: it awaits the
        // builder itself and gets every row for the user. Making the chain
        // thenable is what models that.
        then: (
          onFulfilled: (value: { data: unknown; error: null }) => unknown
        ) => {
          if (table === "subscriptions") state.subscriptionReads += 1;
          return Promise.resolve({
            data: table === "subscriptions" ? state.subscriptions : [],
            error: null,
          }).then(onFulfilled);
        },
        update: (next: Record<string, unknown>) => {
          patch = next;
          return api;
        },
        eq: chain,
        order: chain,
        limit: chain,
        maybeSingle: () =>
          Promise.resolve({
            data: { usage_date: "2026-08-26", count: state.used },
            error: null,
          }),
      });
      return api;
    },
  };
}

function fake(overrides: Partial<Fake> = {}): Fake {
  return {
    buckets: {},
    hits: [],
    used: 0,
    bumps: 0,
    subscriptions: [],
    subscriptionReads: 0,
    ...overrides,
  };
}

// A membership that has actually been paid for.
const PAID = [{ status: "active", current_period_end: null }];
// What hasPlus() also calls Plus, and what the daily breaker must not exempt:
// free to start, and free to start again from a fresh email.
const TRIALING = [{ status: "trialing", current_period_end: null }];

const USER = "user-1";

beforeEach(() => {
  currentAdmin = null;
  vi.restoreAllMocks();
});

describe("a request Hearth's own ceiling sheds is not charged to the user", () => {
  it("hands back the daily usage when the owner-wide DAILY breaker refuses", async () => {
    // THE BUG. bump_ai_usage has already run by the time the global breaker is
    // consulted. Without a refund, a free homeowner who tries a document scan
    // while a swarm has the breaker tripped is charged one of their 25 for a
    // request that never reached the model - and the client tells them Hearth
    // is busy, so they retry, and are charged again, until their day is gone.
    const state = fake({ buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } } });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, false);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("global");
    // Charged one, handed back one.
    expect(state.bumps).toBe(1);
    expect(state.used).toBe(0);
  });

  it("hands it back when the owner-wide HOURLY ceiling refuses too", async () => {
    const state = fake({
      buckets: { "ai-global-hour": { limit: 1500, allowed: false } },
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, false);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("global");
    expect(state.used).toBe(0);
  });

  it("does NOT hand anything back when the user spent their own allowance", async () => {
    // Their limit, their charge. Only Hearth's own brakes are refunded.
    const state = fake({ used: 25 });
    currentAdmin = fakeAdmin(state);
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, false);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("user_daily");
    expect(state.used).toBe(26);
  });

  it("charges exactly one on a request that passes every ceiling", async () => {
    const state = fake();
    currentAdmin = fakeAdmin(state);
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, false);

    expect(result.overLimit).toBe(false);
    expect(state.used).toBe(1);
  });
});

describe("a free-account swarm cannot black out paying customers", () => {
  it("a tripped DAILY breaker does not refuse a PAID member", async () => {
    // The daily breaker is one shared bucket, so a swarm that spends the day's
    // budget by 9am takes every Plus member and every Pro down with it. It
    // still cannot run the bill past the ceiling - the hourly brake below
    // applies to everyone, and a paying account's own DAILY_LIMIT_PLUS still
    // bounds what it can spend - but who gets shed first changes.
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
      subscriptions: PAID,
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, true);

    expect(result.overLimit).toBe(false);
    expect(result.reason).toBeNull();
    // Still COUNTED, though: the bucket has to keep meaning "requests today",
    // not "requests today by free accounts", or the operator's number quietly
    // stops matching the bill.
    expect(state.hits).toContain(AI_GLOBAL_BUCKET);
  });

  it("REFUSES a trialing member, who is `isPlus` but has paid nothing", async () => {
    // THE HOLE THIS CLOSES. hasPlus() counts "trialing" as Plus, which is right
    // for deciding what someone may use and exactly wrong for deciding who may
    // spend past a cost ceiling: a trial is free to start and free to start
    // again from a fresh email, so 20 trial accounts at DAILY_LIMIT_PLUS is the
    // whole global budget with no daily ceiling in front of any of it.
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
      subscriptions: TRIALING,
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, true);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("global");
    // And refunded, like any other account the ceiling sheds.
    expect(state.used).toBe(0);
  });

  it("refuses an expired 'active' row too", async () => {
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
      subscriptions: [
        { status: "active", current_period_end: "2020-01-01T00:00:00.000Z" },
      ],
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    expect((await countAiUsage(USER, true)).overLimit).toBe(true);
  });

  it("fails closed when the membership lookup cannot be trusted", async () => {
    // No subscriptions rows readable means "not paid", which keeps the ceiling
    // standing rather than quietly removing it.
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
      subscriptions: [],
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    expect((await countAiUsage(USER, true)).overLimit).toBe(true);
  });

  it("does not pay for the membership lookup on the normal path", async () => {
    // It only runs when the breaker has already refused, so an ordinary
    // request costs no extra query.
    const state = fake({ subscriptions: PAID });
    currentAdmin = fakeAdmin(state);
    const { countAiUsage } = await import("./aiUsage");

    await countAiUsage(USER, true);

    expect(state.subscriptionReads).toBe(0);
  });

  it("still refuses a free account when the same breaker is tripped", async () => {
    const state = fake({ buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } } });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    expect((await countAiUsage(USER, false)).overLimit).toBe(true);
  });

  it("keeps the HOURLY brake on for paying members", async () => {
    const state = fake({
      buckets: { "ai-global-hour": { limit: 1500, allowed: false } },
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, true);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("global");
    expect(state.hits).toContain("ai-global-hour");
    // And they are not charged for it either.
    expect(state.used).toBe(0);
  });

  it("a tripped DAILY breaker does not refuse a PAID member in the CHAT either", async () => {
    // The chat is the surface a Plus member notices within seconds, and the
    // free-account swarm that trips the shared bucket is exactly the traffic
    // Plus is sold as being insulated from. Same treatment as the tool path.
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
      subscriptions: PAID,
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAskUsage } = await import("./aiUsage");

    const result = await countAskUsage(USER, true);

    expect(result.overLimit).toBe(false);
    expect(result.reason).toBeNull();
    // Counted, like every other request.
    expect(state.hits).toContain(AI_GLOBAL_BUCKET);
    // Their question stands: they were never refused, so there is nothing to
    // hand back.
    expect(state.used).toBe(1);
  });

  it("still refuses a FREE chat user on the same breaker, and refunds the question", async () => {
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAskUsage } = await import("./aiUsage");

    const result = await countAskUsage(USER, false);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("global");
    // Charged one, handed back one: three free questions a day is too few to
    // spend on a request that never reached the model.
    expect(state.bumps).toBe(1);
    expect(state.used).toBe(0);
  });

  it("REFUSES a trialing chat user, and hands their question back", async () => {
    // Same hole as the tool path: a trial is `isPlus` and has paid nothing, so
    // a swarm of trials would walk straight through the ceiling.
    const state = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
      subscriptions: TRIALING,
    });
    currentAdmin = fakeAdmin(state);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { countAskUsage } = await import("./aiUsage");

    const result = await countAskUsage(USER, true);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("global");
    expect(state.used).toBe(0);
  });

  it("still refuses a paying chat user who spent their own allowance", async () => {
    const state = fake({
      buckets: { [`ask-day:${USER}`]: { limit: 15, allowed: false } },
    });
    currentAdmin = fakeAdmin(state);
    const { countAskUsage } = await import("./aiUsage");

    const result = await countAskUsage(USER, true);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("user_daily");
  });

  it("keeps the per-user burst limit on for paying members", async () => {
    const state = fake({
      buckets: { [`ai-tool-burst:${USER}`]: { limit: 10, allowed: false } },
    });
    currentAdmin = fakeAdmin(state);
    const { countAiUsage } = await import("./aiUsage");

    const result = await countAiUsage(USER, true);

    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("user_burst");
    // Refused before anything was charged.
    expect(state.bumps).toBe(0);
  });
});

describe("the owner-wide ceilings are greppable in the logs", () => {
  it("both tripped-breaker lines carry the [ALERT] prefix", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const daily = fake({
      buckets: { [AI_GLOBAL_BUCKET]: { limit: 5000, allowed: false } },
    });
    currentAdmin = fakeAdmin(daily);
    const { countAiUsage } = await import("./aiUsage");
    await countAiUsage(USER, false);

    const hourly = fake({
      buckets: { "ai-global-hour": { limit: 1500, allowed: false } },
    });
    currentAdmin = fakeAdmin(hourly);
    await countAiUsage(USER, false);

    const lines = logged.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[ALERT] AI global spend breaker"))).toBe(
      true
    );
    expect(lines.some((l) => l.startsWith("[ALERT] AI global hourly ceiling"))).toBe(
      true
    );
  });
});
