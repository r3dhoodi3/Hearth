import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// decision.ts imports "server-only" (through its own import and through
// ./facts, which pulls in the service-role client), and that module throws the
// moment it is imported outside a server component. Mocking it out lets the
// real caching logic be driven for real, the same trick parcel.test.ts and
// claude.stream.test.ts already use.
vi.mock("server-only", () => ({}));

// The two reads underneath trialDecision. Both are replaced with counters so a
// test can ask the only question that matters here: how many times did the
// expensive fan-out actually run?
let enforcementCalls = 0;
let computeCalls = 0;
let enforcement: { overrideAllowTrial: boolean | null; manualBlock: boolean } = {
  overrideAllowTrial: null,
  manualBlock: false,
};
let risk: { score: number; level: "low" | "medium" | "high"; reasons: [] } = {
  score: 0,
  level: "low",
  reasons: [],
};
let computeThrows = false;

vi.mock("@/lib/risk/facts", () => ({
  loadEnforcementState: async () => {
    enforcementCalls += 1;
    return enforcement;
  },
  computeRisk: async () => {
    computeCalls += 1;
    if (computeThrows) throw new Error("account_signals is on fire");
    return risk;
  },
}));

// Imported AFTER the mocks above are registered (vi.mock is hoisted, so a
// static import would be fine too - this is the explicit form).
const { trialDecision, TRIAL_DECISION_TTL_MS, __clearTrialDecisionCache } =
  await import("./decision");

beforeEach(() => {
  __clearTrialDecisionCache();
  enforcementCalls = 0;
  computeCalls = 0;
  enforcement = { overrideAllowTrial: null, manualBlock: false };
  risk = { score: 0, level: "low", reasons: [] };
  computeThrows = false;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RENDER = { persist: false as const, maxAgeMs: TRIAL_DECISION_TTL_MS };

describe("trialDecision render-path cache", () => {
  it("computes once and reuses the answer inside the TTL", async () => {
    const first = await trialDecision("user-1", RENDER);
    const second = await trialDecision("user-1", RENDER);

    expect(second).toEqual(first);
    expect(computeCalls).toBe(1);
    expect(enforcementCalls).toBe(1);
  });

  it("is keyed by user id - one account's answer is never another's", async () => {
    await trialDecision("user-1", RENDER);
    await trialDecision("user-2", RENDER);
    expect(computeCalls).toBe(2);
  });

  it("recomputes once the TTL has passed", async () => {
    vi.useFakeTimers();
    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(1);

    vi.advanceTimersByTime(TRIAL_DECISION_TTL_MS + 1);
    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(2);
  });

  it("the checkout path (no maxAgeMs) never reads OR writes the cache", async () => {
    // A page render warms it...
    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(1);

    // ...and the checkout action still computes its own, authoritative answer.
    await trialDecision("user-1", { persist: true });
    expect(computeCalls).toBe(2);

    // The checkout path must not have written anything either: a fresh render
    // still sees the entry the RENDER call left, and nothing more.
    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(2);
  });

  it("never caches a high verdict - it must be re-logged every time", async () => {
    risk = { score: 90, level: "high", reasons: [] };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await trialDecision("user-1", RENDER);
    await trialDecision("user-1", RENDER);

    expect(computeCalls).toBe(2);
  });

  it("a verdict that turns high evicts the low answer it replaces", async () => {
    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(1);

    // Same user, now scoring high. The next read must not be served the stale
    // low answer, and the one after it must not be served the high one either.
    risk = { score: 90, level: "high", reasons: [] };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.advanceTimersByTime(TRIAL_DECISION_TTL_MS + 1);

    const high = await trialDecision("user-1", RENDER);
    expect(high.level).toBe("high");
    expect(computeCalls).toBe(2);

    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(3);
  });

  it("never caches a refused checkout, so clearing a manual flag takes effect", async () => {
    enforcement = { overrideAllowTrial: null, manualBlock: true };

    const blocked = await trialDecision("user-1", RENDER);
    expect(blocked.allowCheckout).toBe(false);

    // The operator clears the flag. The very next render must see it.
    enforcement = { overrideAllowTrial: null, manualBlock: false };
    const allowed = await trialDecision("user-1", RENDER);
    expect(allowed.allowCheckout).toBe(true);
    expect(enforcementCalls).toBe(2);
  });

  it("never caches the fail-open answer from a broken lookup", async () => {
    computeThrows = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const failOpen = await trialDecision("user-1", RENDER);
    expect(failOpen.allowTrial).toBe(true);
    expect(failOpen.allowCheckout).toBe(true);

    // Once the outage is over the real answer must be computed again, not
    // served from a ten-minute-old optimistic default.
    computeThrows = false;
    await trialDecision("user-1", RENDER);
    expect(computeCalls).toBe(2);
  });

  it("an empty user id is answered without touching the cache or the reads", async () => {
    const decision = await trialDecision("", RENDER);
    expect(decision.allowTrial).toBe(true);
    expect(enforcementCalls).toBe(0);
    expect(computeCalls).toBe(0);
  });
});
