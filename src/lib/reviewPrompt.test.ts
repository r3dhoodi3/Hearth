import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceActiveTime,
  createActiveTimeState,
  drawActiveThresholdMs,
  getReviewSessionPlan,
  isAskSession,
  isEligibleForRateFollowUp,
  isEligibleForReviewPrompt,
  isExcludedPath,
  canRequestNativeReview,
  isFirstSession,
  NATIVE_REVIEW_MAX_CALLS,
  NATIVE_REVIEW_WINDOW_MS,
  noteActivity,
  recordNativeReviewCall,
  requestNativeReview,
  REVIEW_ACTIVE_MAX_MS,
  REVIEW_ACTIVE_MIN_MS,
  REVIEW_IDLE_RESET_MS,
  REVIEW_RECENT_ACTIVITY_MS,
  REVIEW_TICK_MS,
  reviewSessionCountKey,
  setActiveTimeVisibility,
} from "@/lib/reviewPrompt";

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const MINUTE = 60 * 1000;

// Every gate passing: 16 minutes of active use in a session that was drawn as
// an ask session, on an ordinary page, for an account that has done something
// meaningful and never settled.
const baseSignals = {
  pathname: "/dashboard",
  isFirstSession: false,
  settled: false,
  hasMeaningfulActivity: true,
  askSession: true,
  activeMs: 16 * MINUTE,
  thresholdMs: 15 * MINUTE,
  msSinceActivity: 2000,
  askedThisSession: false,
};

describe("isEligibleForReviewPrompt: settled means settled", () => {
  it("refuses when this account has rated or answered 'Not really'", () => {
    expect(isEligibleForReviewPrompt({ ...baseSignals, settled: true })).toBe(
      false
    );
  });

  it("allows when nothing permanent has been recorded for this account yet", () => {
    expect(isEligibleForReviewPrompt(baseSignals)).toBe(true);
  });

  it("a card that merely appeared before is NOT settled - that is the whole change", () => {
    // 'prompt_shown' used to settle the account forever, so one silent
    // dismissal ended it. Now the per-session flag handles "not again right
    // now" and only a real answer ends it.
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, askedThisSession: true })
    ).toBe(false);
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, askedThisSession: false })
    ).toBe(true);
  });
});

describe("isEligibleForReviewPrompt: meaningful-action gate", () => {
  it("refuses an account that has not done anything meaningful yet", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, hasMeaningfulActivity: false })
    ).toBe(false);
  });

  it("allows once the account has (claimed a home / posted a job / asked 3+ / a pro applied)", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, hasMeaningfulActivity: true })
    ).toBe(true);
  });
});

describe("isEligibleForReviewPrompt: session, timing and page gates", () => {
  it("never shows during the first session", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, isFirstSession: true })
    ).toBe(false);
  });

  it("never shows in a session that was not drawn as an ask session", () => {
    expect(isEligibleForReviewPrompt({ ...baseSignals, askSession: false })).toBe(
      false
    );
  });

  it("waits for the drawn 15 to 20 minute mark of ACTIVE time", () => {
    expect(
      isEligibleForReviewPrompt({
        ...baseSignals,
        activeMs: 14 * MINUTE,
        thresholdMs: 15 * MINUTE,
      })
    ).toBe(false);
    expect(
      isEligibleForReviewPrompt({
        ...baseSignals,
        activeMs: 15 * MINUTE,
        thresholdMs: 15 * MINUTE,
      })
    ).toBe(true);
    expect(
      isEligibleForReviewPrompt({
        ...baseSignals,
        activeMs: 19 * MINUTE,
        thresholdMs: 20 * MINUTE,
      })
    ).toBe(false);
  });

  it("never lands on a screen nobody has touched for a minute", () => {
    // The idle reset gives five minutes of grace before the clock is wiped,
    // and the threshold can be crossed inside it. Without this rule the card
    // would be sitting there waiting on a phone that was put down.
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, msSinceActivity: 90 * 1000 })
    ).toBe(false);
    expect(
      isEligibleForReviewPrompt({
        ...baseSignals,
        msSinceActivity: REVIEW_RECENT_ACTIVITY_MS,
      })
    ).toBe(true);
  });

  it("never shows on an excluded page even when every other gate passes", () => {
    for (const pathname of [
      "/feedback",
      "/plus",
      "/onboarding",
      "/signin",
      "/checkout",
      "/plus/upgrade",
    ]) {
      expect(
        isEligibleForReviewPrompt({ ...baseSignals, pathname }),
        pathname
      ).toBe(false);
    }
  });

  it("shows on an ordinary signed-in page once every gate passes", () => {
    for (const pathname of ["/dashboard", "/issues", "/contractors", "/chats"]) {
      expect(isEligibleForReviewPrompt({ ...baseSignals, pathname }), pathname).toBe(
        true
      );
    }
  });
});

// The honest follow-up: "did you get a chance to rate Hearth?"
const baseFollowUp = {
  pathname: "/dashboard",
  settled: false,
  awaitingRateConfirm: true,
  rateDeferred: false,
  followUpAskedThisSession: false,
  returnedFromStore: false,
  askSession: false,
  activeMs: 0,
  thresholdMs: 15 * MINUTE,
  msSinceActivity: 2000,
};

describe("isEligibleForRateFollowUp", () => {
  it("never asks when no store link was ever tapped", () => {
    expect(
      isEligibleForRateFollowUp({ ...baseFollowUp, awaitingRateConfirm: false })
    ).toBe(false);
  });

  it("asks straight away when they come back from the store in the same session", () => {
    // The bug this exists for: tapping the link used to count as done, so
    // coming back without rating meant never being asked again.
    expect(
      isEligibleForRateFollowUp({ ...baseFollowUp, returnedFromStore: true })
    ).toBe(true);
  });

  it("asks at the start of the next session too, with no minutes-used bar", () => {
    // They may have closed the app in the App Store and never come back to a
    // live tab; the question is still owed.
    expect(isEligibleForRateFollowUp(baseFollowUp)).toBe(true);
  });

  it("asks at most once per app open", () => {
    expect(
      isEligibleForRateFollowUp({
        ...baseFollowUp,
        returnedFromStore: true,
        followUpAskedThisSession: true,
      })
    ).toBe(false);
  });

  it("after a 'Not yet' it rejoins the pool: ask session AND the active-time bar", () => {
    const deferred = { ...baseFollowUp, rateDeferred: true };
    expect(isEligibleForRateFollowUp(deferred)).toBe(false);
    expect(
      isEligibleForRateFollowUp({ ...deferred, askSession: true, activeMs: 0 })
    ).toBe(false);
    expect(
      isEligibleForRateFollowUp({
        ...deferred,
        askSession: true,
        activeMs: 16 * MINUTE,
      })
    ).toBe(true);
    // ...and, like the first card, not onto an untouched screen.
    expect(
      isEligibleForRateFollowUp({
        ...deferred,
        askSession: true,
        activeMs: 16 * MINUTE,
        msSinceActivity: 5 * MINUTE,
      })
    ).toBe(false);
  });

  it("stops for good once the account is settled, and stays off excluded pages", () => {
    expect(
      isEligibleForRateFollowUp({
        ...baseFollowUp,
        returnedFromStore: true,
        settled: true,
      })
    ).toBe(false);
    expect(
      isEligibleForRateFollowUp({
        ...baseFollowUp,
        returnedFromStore: true,
        pathname: "/plus",
      })
    ).toBe(false);
  });
});

describe("isExcludedPath", () => {
  it("matches the route itself, anything inside it, and a query string", () => {
    expect(isExcludedPath("/feedback")).toBe(true);
    expect(isExcludedPath("/feedback/thanks")).toBe(true);
    expect(isExcludedPath("/plus")).toBe(true);
    expect(isExcludedPath("/plus?reason=ask")).toBe(true);
    expect(isExcludedPath("/plus/upgrade?ref=x")).toBe(true);
    expect(isExcludedPath("/plus#plans")).toBe(true);
  });

  it("excludes the sign-in route that actually exists", () => {
    // The list said "/sign-in" for a route that is spelled /signin, so the
    // prompt could appear over the sign-in page while excluding a page that
    // has never existed.
    expect(isExcludedPath("/signin")).toBe(true);
    expect(isExcludedPath("/signin?next=/dashboard")).toBe(true);
    expect(isExcludedPath("/sign-in")).toBe(false);
  });

  it("matches segment-wise, so a route that merely starts the same is not excluded", () => {
    // The bare startsWith() this replaced excluded /plusters too.
    expect(isExcludedPath("/plusters")).toBe(false);
    expect(isExcludedPath("/feedbackery")).toBe(false);
    expect(isExcludedPath("/signing-up")).toBe(false);
    expect(isExcludedPath("/dashboard")).toBe(false);
  });
});

// A minimal Storage stand-in so the storage-backed helpers are testable
// without jsdom - this file runs in vitest's default "node" environment.
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = { ...initial };
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

describe("isFirstSession", () => {
  it("is true the first time, and marks the browser as seen", () => {
    const storage = fakeStorage();
    expect(isFirstSession(storage)).toBe(true);
    expect(storage.getItem("hearth_first_seen_at")).not.toBeNull();
  });

  it("is false on every call after the first", () => {
    const storage = fakeStorage();
    expect(isFirstSession(storage)).toBe(true);
    expect(isFirstSession(storage)).toBe(false);
    expect(isFirstSession(storage)).toBe(false);
  });

  it("is false immediately when the browser was already seen before", () => {
    const storage = fakeStorage({ hearth_first_seen_at: "1700000000000" });
    expect(isFirstSession(storage)).toBe(false);
  });

  it("fails toward NOT showing the prompt when storage throws", () => {
    const angryStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(isFirstSession(angryStorage)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Active time
// ---------------------------------------------------------------------------
// Driven off fake timers so the clock the component actually reads (Date.now)
// is the clock under test, rather than a set of hand-written timestamps that
// could drift from what the browser would produce.
describe("active time: only while visible, reset when idle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // One tick of the component's interval, with a tap so the idle clock stays
  // fresh unless a test deliberately lets it run out.
  function tick(state: ReturnType<typeof createActiveTimeState>, taps = true) {
    vi.advanceTimersByTime(REVIEW_TICK_MS);
    const next = advanceActiveTime(state, Date.now());
    return taps ? noteActivity(next, Date.now()) : next;
  }

  it("banks time while the tab is visible", () => {
    let state = createActiveTimeState(Date.now());
    for (let i = 0; i < 4; i++) state = tick(state);
    expect(state.totalMs).toBe(4 * REVIEW_TICK_MS);
  });

  it("banks nothing at all while the tab is hidden", () => {
    let state = createActiveTimeState(Date.now());
    state = tick(state);
    state = setActiveTimeVisibility(state, false, Date.now());
    const banked = state.totalMs;

    vi.advanceTimersByTime(30 * MINUTE);
    state = advanceActiveTime(state, Date.now());
    expect(state.totalMs).toBe(banked);

    // Coming back counts as activity, so a spell in another app does not wipe
    // the minutes that were genuinely spent here.
    state = setActiveTimeVisibility(state, true, Date.now());
    state = tick(state);
    expect(state.totalMs).toBe(banked + REVIEW_TICK_MS);
  });

  it("resets to zero after five minutes on screen with nothing touched", () => {
    let state = createActiveTimeState(Date.now());
    for (let i = 0; i < 8; i++) state = tick(state);
    expect(state.totalMs).toBe(8 * REVIEW_TICK_MS);

    // No taps, no keys, no scrolling from here on.
    for (let i = 0; i < REVIEW_IDLE_RESET_MS / REVIEW_TICK_MS; i++) {
      state = tick(state, false);
    }
    expect(state.totalMs).toBe(0);

    // And it starts over from zero, not from where it left off.
    state = noteActivity(state, Date.now());
    state = tick(state);
    expect(state.totalMs).toBe(REVIEW_TICK_MS);
  });

  it("a suspended tab cannot bank the whole gap in one tick", () => {
    // Screen off with Hearth foregrounded: the interval does not run, then
    // fires once with twenty minutes of wall clock behind it.
    let state = createActiveTimeState(Date.now());
    state = noteActivity(state, Date.now());
    vi.advanceTimersByTime(20 * MINUTE);
    // Activity first, so this is the clamp being tested and not the idle reset.
    state = noteActivity(state, Date.now());
    state = advanceActiveTime(state, Date.now());
    expect(state.totalMs).toBeLessThanOrEqual(REVIEW_TICK_MS * 4);
  });

  it("reaches a 15 minute threshold after 15 minutes of use, not 15 minutes of wall clock", () => {
    let state = createActiveTimeState(Date.now());
    // Ten minutes of use, then a two minute look at another app, then five
    // more minutes of use: 17 minutes on the wall, 15 in the app.
    for (let i = 0; i < (10 * MINUTE) / REVIEW_TICK_MS; i++) state = tick(state);
    state = setActiveTimeVisibility(state, false, Date.now());
    vi.advanceTimersByTime(2 * MINUTE);
    state = setActiveTimeVisibility(state, true, Date.now());
    expect(state.totalMs).toBeLessThan(15 * MINUTE);
    for (let i = 0; i < (5 * MINUTE) / REVIEW_TICK_MS; i++) state = tick(state);
    expect(state.totalMs).toBe(15 * MINUTE);
  });
});

describe("drawActiveThresholdMs", () => {
  it("is uniform across the owner's 15 to 20 minute window", () => {
    expect(drawActiveThresholdMs(() => 0)).toBe(REVIEW_ACTIVE_MIN_MS);
    expect(drawActiveThresholdMs(() => 1)).toBe(REVIEW_ACTIVE_MAX_MS);
    expect(drawActiveThresholdMs(() => 0.5)).toBe(17.5 * MINUTE);
  });

  it("never lands outside the window, whatever it is handed", () => {
    for (const r of [-5, 0.13, 0.99, 7, Number.NaN]) {
      const ms = drawActiveThresholdMs(() => r);
      expect(ms, String(r)).toBeGreaterThanOrEqual(REVIEW_ACTIVE_MIN_MS);
      expect(ms, String(r)).toBeLessThanOrEqual(REVIEW_ACTIVE_MAX_MS);
    }
  });
});

describe("isAskSession: the first few, then one in four", () => {
  it("never asks in the very first session", () => {
    expect(isAskSession({ sessionNumber: 1, roll: 0 })).toBe(false);
  });

  it("always asks in sessions 2 through 5, whatever the roll", () => {
    for (let n = 2; n <= 5; n++) {
      expect(isAskSession({ sessionNumber: n, roll: 0.99 }), `session ${n}`).toBe(
        true
      );
    }
  });

  it("from session 6 it is one app open in four", () => {
    expect(isAskSession({ sessionNumber: 6, roll: 0.24 })).toBe(true);
    expect(isAskSession({ sessionNumber: 6, roll: 0.25 })).toBe(false);
    expect(isAskSession({ sessionNumber: 40, roll: 0.1 })).toBe(true);
    expect(isAskSession({ sessionNumber: 40, roll: 0.9 })).toBe(false);
  });

  it("poolOnly drops the guaranteed early sessions (what a 'Not yet' buys)", () => {
    expect(isAskSession({ sessionNumber: 3, roll: 0.9, poolOnly: true })).toBe(
      false
    );
    expect(isAskSession({ sessionNumber: 3, roll: 0.1, poolOnly: true })).toBe(
      true
    );
  });
});

describe("getReviewSessionPlan: counted once per app open, per user", () => {
  const USER = "user-abc";

  it("counts sessions in localStorage keyed by the user id", () => {
    const local = fakeStorage();
    // A fresh sessionStorage each time is what a new app open looks like.
    const first = getReviewSessionPlan({
      userId: USER,
      local,
      session: fakeStorage(),
      random: () => 0.5,
    });
    expect(first?.sessionNumber).toBe(1);
    expect(local.getItem(reviewSessionCountKey(USER))).toBe("1");

    const second = getReviewSessionPlan({
      userId: USER,
      local,
      session: fakeStorage(),
      random: () => 0.5,
    });
    expect(second?.sessionNumber).toBe(2);

    // Another account on the same phone starts at 1, not at 3.
    const other = getReviewSessionPlan({
      userId: "user-xyz",
      local,
      session: fakeStorage(),
      random: () => 0.5,
    });
    expect(other?.sessionNumber).toBe(1);
  });

  it("draws once per app open, not once per page view", () => {
    const local = fakeStorage({ [reviewSessionCountKey(USER)]: "9" });
    const session = fakeStorage();
    const rolls = [0.1, 0.4];
    let i = 0;
    const random = () => rolls[i++ % rolls.length];

    const plan = getReviewSessionPlan({ userId: USER, local, session, random });
    expect(plan?.sessionNumber).toBe(10);
    expect(plan?.askSession).toBe(true); // roll 0.1 < 0.25

    // Every later navigation in the same tab reads the same plan back, so a
    // "one in four sessions" rule cannot decay into "one in four page views".
    const callsBefore = i;
    const again = getReviewSessionPlan({ userId: USER, local, session, random });
    expect(i).toBe(callsBefore);
    expect(again).toEqual(plan);
    expect(local.getItem(reviewSessionCountKey(USER))).toBe("10");
  });

  it("sessions 2 to 5 ask regardless of the roll; session 6+ needs the 1 in 4", () => {
    const local = fakeStorage({ [reviewSessionCountKey("u")]: "1" });
    const askEarly = getReviewSessionPlan({
      userId: "u",
      local,
      session: fakeStorage(),
      random: () => 0.99,
    });
    expect(askEarly?.sessionNumber).toBe(2);
    expect(askEarly?.askSession).toBe(true);

    local.setItem(reviewSessionCountKey("u"), "5");
    const cold = getReviewSessionPlan({
      userId: "u",
      local,
      session: fakeStorage(),
      random: () => 0.99,
    });
    expect(cold?.sessionNumber).toBe(6);
    expect(cold?.askSession).toBe(false);
  });

  it("the threshold it stores is inside the 15 to 20 minute window", () => {
    for (const r of [0, 0.37, 1]) {
      const plan = getReviewSessionPlan({
        userId: "u",
        local: fakeStorage(),
        session: fakeStorage(),
        random: () => r,
      });
      expect(plan?.thresholdMs).toBeGreaterThanOrEqual(REVIEW_ACTIVE_MIN_MS);
      expect(plan?.thresholdMs).toBeLessThanOrEqual(REVIEW_ACTIVE_MAX_MS);
    }
  });

  it("returns null when storage throws, so a browser that cannot remember never nags", () => {
    const angry = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(
      getReviewSessionPlan({ userId: "u", local: angry, session: fakeStorage() })
    ).toBeNull();
  });
});

describe("requestNativeReview", () => {
  it("is a no-op on the web and never throws", () => {
    // No Capacitor global in this environment, so it returns before it can
    // spend one of the three yearly attempts a real phone gets.
    expect(() => requestNativeReview()).not.toThrow();
    expect(requestNativeReview()).toBeUndefined();
  });
});

// Hearth's own cap, on top of Apple's three-a-year and Google's undocumented
// quota. The point is not to duplicate them: it is that a call past the OS cap
// is silently swallowed, so spending all three in one week on the same person
// throws the year away.
describe("native review: at most three attempts per device per year", () => {
  const NOW = Date.parse("2026-08-29T10:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("allows exactly three, then stops", () => {
    const storage = fakeStorage();
    for (let i = 0; i < NATIVE_REVIEW_MAX_CALLS; i++) {
      expect(canRequestNativeReview(NOW + i * DAY, storage), `call ${i}`).toBe(
        true
      );
      recordNativeReviewCall(NOW + i * DAY, storage);
    }
    expect(canRequestNativeReview(NOW + 3 * DAY, storage)).toBe(false);
  });

  it("forgets attempts older than the rolling year", () => {
    const storage = fakeStorage();
    for (let i = 0; i < NATIVE_REVIEW_MAX_CALLS; i++) {
      recordNativeReviewCall(NOW + i, storage);
    }
    expect(canRequestNativeReview(NOW + DAY, storage)).toBe(false);
    expect(
      canRequestNativeReview(NOW + NATIVE_REVIEW_WINDOW_MS + DAY, storage)
    ).toBe(true);
  });

  it("counts per device, not per account: one shared log, not one per user", () => {
    // Apple caps its sheet per app per device. A per-account key would let two
    // accounts on one phone try six times against a three-try allowance.
    const storage = fakeStorage();
    for (let i = 0; i < NATIVE_REVIEW_MAX_CALLS; i++) {
      recordNativeReviewCall(NOW + i, storage);
    }
    expect(storage.getItem("hearth_native_review_calls")).not.toBeNull();
    expect(storage.length).toBe(1);
  });

  it("fails toward NOT asking on unreadable or corrupt storage", () => {
    const angry = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(canRequestNativeReview(NOW, angry)).toBe(false);
    expect(() => recordNativeReviewCall(NOW, angry)).not.toThrow();

    const junk = fakeStorage({ hearth_native_review_calls: "not json" });
    expect(canRequestNativeReview(NOW, junk)).toBe(false);

    // A wrong-shaped value is treated as no history rather than as a number.
    const wrongShape = fakeStorage({
      hearth_native_review_calls: '["yesterday", null]',
    });
    expect(canRequestNativeReview(NOW, wrongShape)).toBe(true);
  });
});

// A guard, not a behaviour test. The "$5 lead credit for a rating" idea comes
// back around every few months and is a store-removal-grade violation, so the
// reasoning has to stay in the file where somebody would go to add it.
describe("no incentives, and nothing that could grow into one", () => {
  const lib = read("src/lib/reviewPrompt.ts");
  const component = read("src/components/ReviewPrompt.tsx");

  it("keeps the written explanation of why a reward cannot be attached", () => {
    expect(lib).toContain("NO INCENTIVES");
    expect(lib).toContain("1.1.7");
    expect(lib).toContain("FTC");
  });

  it("has no credit, discount or reward wiring anywhere in the prompt", () => {
    for (const source of [lib, component]) {
      expect(source).not.toMatch(/grantCredit|leadCredit|addCredit|reward\(/i);
    }
  });

  it("says on the record that the native prompt is Apple's own and unrewardable", () => {
    expect(lib).toContain("SKStoreReviewController");
  });

  it("keeps the 5.6.1 reason the native path skips the card written down", () => {
    // Apple rules out a "do you like this app?" filter in front of the system
    // review sheet, so the native branch must never grow one back.
    expect(component).toContain("5.6.1");
    expect(component).toContain("if (nativeRef.current) return null;");
  });

  it("adds no Capacitor dependency to the web build", () => {
    const adapter = read("src/lib/nativeReview.ts");
    expect(adapter).not.toMatch(/^import .*@capacitor/m);
    expect(read("package.json")).not.toContain("@capacitor");
  });
});

describe("migration 0133: app_feedback RLS", () => {
  const MIGRATION = "supabase/migrations/0133_app_feedback.sql";
  const PASTE_ME = "supabase/PASTE-ME-live-2026-08-27-app-feedback.sql";
  const sql = read(MIGRATION);

  it("enables row level security", () => {
    expect(sql).toContain("alter table public.app_feedback enable row level security;");
  });

  it("lets a user insert only their own row", () => {
    expect(sql).toContain('create policy "app_feedback self insert" on public.app_feedback');
    expect(sql).toContain("for insert to authenticated");
    expect(sql).toContain("with check (user_id = auth.uid());");
  });

  it("grants no select policy at all - not even a self-select", () => {
    // The whole point: an account cannot read back whether it has been shown
    // or answered the prompt, or read anyone's feedback message, including
    // its own. This is what forces getReviewPromptSignals() (the eligibility
    // check) onto the service-role client.
    expect(sql).not.toContain("for select");
    expect(sql).not.toContain("using (user_id = auth.uid())");
  });

  it("constrains side to homeowner or pro", () => {
    expect(sql).toContain("check (side in ('homeowner', 'pro'))");
  });

  it("cascades on the user being deleted, like every other per-user table", () => {
    expect(sql).toContain(
      "user_id       uuid not null references auth.users (id) on delete cascade,"
    );
  });

  it("makes the message-less prompt events idempotent per account", () => {
    // recordReviewPromptEvent is a server action: any signed-in account can
    // call it directly, in a loop. "At most one row per kind" has to be a
    // database constraint, not an app-level read-then-write.
    for (const source of [sql, read(PASTE_ME)]) {
      expect(source).toContain(
        "create unique index if not exists app_feedback_one_event_per_kind_idx"
      );
      expect(source).toContain("on public.app_feedback (user_id, kind)");
      expect(source).toContain("where message is null");
    }
  });

  it("leaves the feedback form's own rows unconstrained", () => {
    // The partial index is deliberately scoped to `message is null`: a
    // homeowner with two things to tell us gets to send both notes.
    expect(sql).toMatch(
      /app_feedback_one_event_per_kind_idx[\s\S]{0,120}where message is null/
    );
  });

  it("has a matching PASTE-ME bundle carrying the same table and policy", () => {
    const paste = read(PASTE_ME);
    expect(paste).toContain("create table if not exists public.app_feedback");
    expect(paste).toContain('create policy "app_feedback self insert" on public.app_feedback');
    expect(paste).toContain("for insert to authenticated");
  });
});

describe("migration 0142: the three return-from-the-store kinds", () => {
  const MIGRATION = "supabase/migrations/0142_review_prompt_events.sql";
  const PASTE_ME = "supabase/PASTE-ME-live-2026-08-29-review-prompt.sql";
  const sources = [read(MIGRATION), read(PASTE_ME)];

  it("widens the kind constraint to all six events", () => {
    for (const sql of sources) {
      for (const kind of [
        "prompt_shown",
        "loved",
        "not_really",
        "rate_clicked",
        "rate_deferred",
        "rated",
      ]) {
        expect(sql).toContain(`'${kind}'`);
      }
      expect(sql).toContain("add constraint app_feedback_kind_check");
    }
  });

  it("drops the old constraint by definition, so it is safe to re-run", () => {
    for (const sql of sources) {
      expect(sql).toContain("drop constraint %I");
      expect(sql).toContain("pg_get_constraintdef(con.oid) like '%prompt_shown%'");
    }
  });

  it("refuses to run before the table exists rather than half-applying", () => {
    for (const sql of sources) {
      expect(sql).toContain("to_regclass('public.app_feedback') is null");
      expect(sql).toContain("raise exception");
    }
  });

  it("adds no policy, no column and no table - it is a constraint change only", () => {
    for (const sql of sources) {
      expect(sql).not.toContain("create policy");
      expect(sql).not.toContain("add column");
      expect(sql).not.toContain("create table");
    }
  });

  it("the paste bundle ends with verify queries an owner can actually run", () => {
    const paste = read(PASTE_ME);
    expect(paste).toContain("VERIFY");
    expect(paste).toContain("pg_get_constraintdef(oid)");
    expect(paste).toContain("from pg_indexes");
    expect(paste).toContain("relrowsecurity");
  });
});

// The two writes into app_feedback are both reachable as server actions with
// no form in front of them, so both need a cap and neither may hard-fail on
// the unique index. A source-text check: the wiring compiles either way.
describe("feedback actions: rate limits, idempotent inserts, honest signals", () => {
  const actions = read("src/app/(app)/feedback/actions.ts");

  it("caps prompt events per account per day", () => {
    expect(actions).toContain("`review-prompt:${user.id}`");
    expect(actions).toMatch(/p_limit: 20,[\s\S]{0,40}p_window_seconds: 86400/);
  });

  it("caps written feedback per account per hour, like the support form", () => {
    expect(actions).toContain("`feedback:${user.id}`");
    expect(actions).toMatch(/p_limit: 5,[\s\S]{0,40}p_window_seconds: 3600/);
  });

  it("fails OPEN on a limiter error: only an explicit false blocks", () => {
    // A spam bucket, not a brute-force one. `allowed == null` (the RPC errored
    // or the function is missing) must never stop a real homeowner.
    expect(actions).not.toContain("if (!allowed)");
    expect(actions.match(/allowed === false/g) ?? []).toHaveLength(2);
  });

  it("treats the unique-index collision as already recorded", () => {
    expect(actions).toContain('error.code !== "23505"');
  });

  it("only 'rated' and 'not_really' settle the account", () => {
    expect(actions).toContain('const SETTLING_KINDS = new Set(["rated", "not_really"]);');
    // It has to read the kinds to know that; "does any row exist" was the old,
    // wrong answer.
    expect(actions).toContain('.select("kind")');
  });

  it("returns null on a failed read instead of a fake 'settled'", () => {
    // The browser writes a permanent never-ask-again flag when it is told the
    // account has settled, so a database hiccup must not be able to say that.
    expect(actions).toMatch(/getReviewPromptSignals failed[\s\S]{0,600}return null;/);
  });
});
