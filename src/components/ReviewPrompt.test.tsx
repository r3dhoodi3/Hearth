// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The pathname the whole file renders against unless a test overrides it.
let mockPathname = "/dashboard";
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}));

// Both are "use server" files elsewhere (Stripe/Supabase-adjacent); the
// component only ever calls them as plain functions, so a stub is enough to
// keep this test in the UI layer.
const mockGetSignals = vi.fn();
const mockRecordEvent = vi.fn();
vi.mock("@/app/(app)/feedback/actions", () => ({
  getReviewPromptSignals: (...args: unknown[]) => mockGetSignals(...args),
  recordReviewPromptEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

// Real eligibility, real active-time clock, real session plan (all pure and
// already covered on their own in src/lib/reviewPrompt.test.ts); only the two
// side-effecting/native pieces are swapped out.
const mockRequestNativeReview = vi.fn();
vi.mock("@/lib/reviewPrompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reviewPrompt")>();
  return {
    ...actual,
    isFirstSession: () => false,
    requestNativeReview: () => mockRequestNativeReview(),
  };
});

import ReviewPrompt from "./ReviewPrompt";
import { reviewSessionCountKey } from "@/lib/reviewPrompt";

const MINUTE = 60 * 1000;
const USER = "user-1";

const ELIGIBLE_SIGNALS = {
  userId: USER,
  settled: false,
  awaitingRateConfirm: false,
  rateDeferred: false,
  hasMeaningfulActivity: true,
};

// Mount and let the 3 second settle timer and the signals fetch both finish.
// Advancing time also flushes the microtasks the resolved fetch queues.
async function mountAndSettle() {
  const result = render(<ReviewPrompt />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  return result;
}

// Somebody actually using the app: time passes AND the screen gets touched, so
// the five minute idle reset never fires. Touch events go on window, which is
// where the component listens.
async function spendTimeInApp(ms: number, { touch = true } = {}) {
  const stepMs = MINUTE;
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
    if (touch) {
      await act(async () => {
        window.dispatchEvent(new Event("pointerdown"));
      });
    }
  }
}

// jsdom has no real page lifecycle, so visibility is faked the way the browser
// reports it: the property plus the event.
async function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-29T10:00:00Z"));
  mockPathname = "/dashboard";
  mockGetSignals.mockReset().mockResolvedValue(ELIGIBLE_SIGNALS);
  mockRecordEvent.mockReset().mockResolvedValue(undefined);
  mockPush.mockReset();
  mockRequestNativeReview.mockReset();
  delete process.env.NEXT_PUBLIC_APP_STORE_URL;
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Session 2 by default: inside "the first few", so every session is an ask
  // session and only the clock is under test.
  window.localStorage.setItem(reviewSessionCountKey(USER), "1");
  // Both dice: the ask-session roll and the 15 to 20 minute draw. 0 puts the
  // threshold at exactly 15 minutes so the assertions can be exact.
  vi.spyOn(Math, "random").mockReturnValue(0);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ReviewPrompt: the 15 to 20 minute active-time rule", () => {
  it("shows nothing after three seconds, and nothing after ten minutes of use", async () => {
    await mountAndSettle();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    await spendTimeInApp(10 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("shows once the drawn threshold of ACTIVE time is reached", async () => {
    await mountAndSettle();
    await spendTimeInApp(16 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
    // Logged for staff to count. It is no longer what stops the card coming
    // back: only a real answer does that.
    expect(mockRecordEvent).toHaveBeenCalledWith("prompt_shown");
    expect(
      window.localStorage.getItem("hearth_review_prompt_settled")
    ).toBeNull();
  });

  it("does not count time while the tab is hidden", async () => {
    await mountAndSettle();
    await setVisibility("hidden");
    await spendTimeInApp(25 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();

    await setVisibility("visible");
    await spendTimeInApp(16 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
  });

  it("resets after five minutes on screen with nothing touched", async () => {
    await mountAndSettle();
    await spendTimeInApp(12 * MINUTE);
    // Phone put down on the counter, app still open and lit.
    await spendTimeInApp(6 * MINUTE, { touch: false });
    // Back to using it: the twelve minutes are gone, so six more is not
    // eighteen.
    await spendTimeInApp(6 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    await spendTimeInApp(10 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
  });

  it("keeps the clock across a route change, since it is a session measure", async () => {
    const { rerender } = await mountAndSettle();
    await spendTimeInApp(10 * MINUTE);
    mockPathname = "/issues";
    rerender(<ReviewPrompt />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await spendTimeInApp(6 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
  });
});

describe("ReviewPrompt: which app opens are allowed to ask", () => {
  it("never asks in the account's very first session", async () => {
    window.localStorage.removeItem(reviewSessionCountKey(USER));
    await mountAndSettle();
    await spendTimeInApp(25 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("asks in sessions 2 through 5 whatever the roll says", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    window.localStorage.setItem(reviewSessionCountKey(USER), "4");
    await mountAndSettle();
    // Threshold drawn at 0.99 is the top of the window: 20 minutes.
    await spendTimeInApp(21 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
  });

  it("from session 6 on, a losing roll means this app open never asks", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    window.localStorage.setItem(reviewSessionCountKey(USER), "9");
    await mountAndSettle();
    await spendTimeInApp(25 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("from session 6 on, a winning roll asks on the same terms", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    window.localStorage.setItem(reviewSessionCountKey(USER), "9");
    await mountAndSettle();
    // Threshold drawn at 0.1: 15.5 minutes.
    await spendTimeInApp(16 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
  });
});

describe("ReviewPrompt: nothing renders where it must not", () => {
  it("never fetches or shows on an excluded page", async () => {
    mockPathname = "/feedback";
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(mockGetSignals).not.toHaveBeenCalled();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("stays hidden, and remembers, when the account has already settled", async () => {
    mockGetSignals.mockResolvedValue({ ...ELIGIBLE_SIGNALS, settled: true });
    const { unmount } = await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hearth_review_prompt_settled")).toBe("1");
    unmount();

    // A fresh mount must not call the server again: the localStorage flag
    // already answers the question.
    mockGetSignals.mockClear();
    await mountAndSettle();
    expect(mockGetSignals).not.toHaveBeenCalled();
  });

  it("stays hidden when the account has done nothing meaningful yet", async () => {
    mockGetSignals.mockResolvedValue({
      ...ELIGIBLE_SIGNALS,
      hasMeaningfulActivity: false,
    });
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("stays hidden, and writes nothing, when the signal fetch fails", async () => {
    mockGetSignals.mockResolvedValue(null);
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(
      window.localStorage.getItem("hearth_review_prompt_settled")
    ).toBeNull();
  });
});

describe("ReviewPrompt: love it -> rate -> the honest follow-up", () => {
  async function showCard() {
    await mountAndSettle();
    await spendTimeInApp(16 * MINUTE);
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
  }

  it("Love it moves to the thank-you step without any native prompt", async () => {
    await showCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));
    expect(mockRecordEvent).toHaveBeenCalledWith("loved");
    expect(screen.getByText("Rate Hearth")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Thank you. A quick rating helps other homeowners find Hearth."
      )
    ).toBeInTheDocument();
    expect(mockRequestNativeReview).not.toHaveBeenCalled();
  });

  it("hides the App Store button entirely when the env var is unset", async () => {
    await showCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));
    expect(
      screen.queryByRole("link", { name: "Rate on the App Store" })
    ).not.toBeInTheDocument();
  });

  it("tapping the store link records an intent, NEVER a rating", async () => {
    process.env.NEXT_PUBLIC_APP_STORE_URL = "https://apps.apple.com/app/hearth";
    await showCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));
    const link = screen.getByRole("link", { name: "Rate on the App Store" });
    expect(link).toHaveAttribute("href", "https://apps.apple.com/app/hearth");

    fireEvent.click(link);
    expect(mockRequestNativeReview).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent).toHaveBeenCalledWith("rate_clicked");
    // The bug: this used to be the end of it. Apple never tells us whether a
    // rating was left, so nothing here may claim one.
    expect(mockRecordEvent).not.toHaveBeenCalledWith("rated");
    expect(
      window.localStorage.getItem("hearth_review_prompt_settled")
    ).toBeNull();
  });

  it("asks when they come back, and 'Yes, done' is the only thing that settles it", async () => {
    process.env.NEXT_PUBLIC_APP_STORE_URL = "https://apps.apple.com/app/hearth";
    await showCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));
    fireEvent.click(screen.getByRole("link", { name: "Rate on the App Store" }));
    expect(screen.queryByText("Rate Hearth")).not.toBeInTheDocument();

    // Off to the App Store and back.
    await setVisibility("hidden");
    await setVisibility("visible");
    expect(
      screen.queryByText("Did you get a chance to rate Hearth?")
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      screen.getByText("Did you get a chance to rate Hearth?")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Yes, done" }));
    expect(mockRecordEvent).toHaveBeenCalledWith("rated");
    expect(window.localStorage.getItem("hearth_review_prompt_settled")).toBe("1");
    expect(
      screen.queryByText("Did you get a chance to rate Hearth?")
    ).not.toBeInTheDocument();
  });

  it("'Not yet' defers instead of settling, and does not ask again this session", async () => {
    process.env.NEXT_PUBLIC_APP_STORE_URL = "https://apps.apple.com/app/hearth";
    await showCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));
    fireEvent.click(screen.getByRole("link", { name: "Rate on the App Store" }));
    await setVisibility("hidden");
    await setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(mockRecordEvent).toHaveBeenCalledWith("rate_deferred");
    expect(mockRecordEvent).not.toHaveBeenCalledWith("rated");
    expect(
      window.localStorage.getItem("hearth_review_prompt_settled")
    ).toBeNull();

    // Back to the store screen and back again: no second ask in the same app
    // open, and no more minutes of use bring it back either.
    await setVisibility("hidden");
    await setVisibility("visible");
    await spendTimeInApp(20 * MINUTE);
    expect(
      screen.queryByText("Did you get a chance to rate Hearth?")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("asks the follow-up at the start of the next session, with no minutes needed", async () => {
    // A new app open: sessionStorage is gone, the account's session count and
    // the server's memory of the tap are not.
    mockGetSignals.mockResolvedValue({
      ...ELIGIBLE_SIGNALS,
      awaitingRateConfirm: true,
    });
    await mountAndSettle();
    expect(
      screen.getByText("Did you get a chance to rate Hearth?")
    ).toBeInTheDocument();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("does not ask the follow-up in a non-ask session once it has been deferred", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    window.localStorage.setItem(reviewSessionCountKey(USER), "9");
    mockGetSignals.mockResolvedValue({
      ...ELIGIBLE_SIGNALS,
      awaitingRateConfirm: true,
      rateDeferred: true,
    });
    await mountAndSettle();
    await spendTimeInApp(25 * MINUTE);
    expect(
      screen.queryByText("Did you get a chance to rate Hearth?")
    ).not.toBeInTheDocument();
  });
});

// Inside a Capacitor shell the card must never appear: App Store Review
// Guideline 5.6.1 rules out a "do you like this app?" filter in front of the
// system review sheet, and Google Play's own docs say it outright.
describe("ReviewPrompt: on native, no card, just the system sheet", () => {
  type CapacitorWindow = Window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  };

  beforeEach(() => {
    (window as CapacitorWindow).Capacitor = { isNativePlatform: () => true };
  });
  afterEach(() => {
    delete (window as CapacitorWindow).Capacitor;
  });

  it("never renders the pre-filter card, however long the app is used", async () => {
    await mountAndSettle();
    await spendTimeInApp(25 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    // And it does not ask the server anything either: none of the card's
    // signals matter when there is no card.
    expect(mockGetSignals).not.toHaveBeenCalled();
    expect(mockRequestNativeReview).not.toHaveBeenCalled();
  });

  it("asks the OS once a positive moment and the active-time bar are both met", async () => {
    await mountAndSettle();
    // A pro was hired earlier in the session (HireAgainButton reports this).
    window.sessionStorage.setItem("hearth_review_moment", "job_hired");
    await spendTimeInApp(10 * MINUTE);
    expect(mockRequestNativeReview).not.toHaveBeenCalled();
    await spendTimeInApp(6 * MINUTE);
    expect(mockRequestNativeReview).toHaveBeenCalledTimes(1);
    // The moment is spent, and no second ask in the same app open.
    expect(window.sessionStorage.getItem("hearth_review_moment")).toBeNull();
    await spendTimeInApp(20 * MINUTE);
    expect(mockRequestNativeReview).toHaveBeenCalledTimes(1);
  });

  it("never asks without a positive moment, however long they use it", async () => {
    await mountAndSettle();
    await spendTimeInApp(25 * MINUTE);
    expect(mockRequestNativeReview).not.toHaveBeenCalled();
  });

  it("never asks on an excluded page", async () => {
    mockPathname = "/plus";
    await mountAndSettle();
    window.sessionStorage.setItem("hearth_review_moment", "plan_built");
    await spendTimeInApp(20 * MINUTE);
    expect(mockRequestNativeReview).not.toHaveBeenCalled();
  });
});

describe("ReviewPrompt: not really", () => {
  it("logs 'not_really', settles for good, and routes to /feedback", async () => {
    await mountAndSettle();
    await spendTimeInApp(16 * MINUTE);
    fireEvent.click(screen.getByRole("button", { name: "Not really" }));

    expect(mockRecordEvent).toHaveBeenCalledWith("not_really");
    expect(mockPush).toHaveBeenCalledWith("/feedback");
    expect(window.localStorage.getItem("hearth_review_prompt_settled")).toBe("1");
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(screen.queryByText("Rate Hearth")).not.toBeInTheDocument();
  });
});

describe("ReviewPrompt: dismiss is a snooze, not an answer", () => {
  it("the X closes the card for this session only, and records nothing extra", async () => {
    await mountAndSettle();
    await spendTimeInApp(16 * MINUTE);
    const callsBeforeDismiss = mockRecordEvent.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(mockRecordEvent.mock.calls.length).toBe(callsBeforeDismiss);
    expect(mockPush).not.toHaveBeenCalled();
    // A mis-tap on an X must not end the conversation forever.
    expect(
      window.localStorage.getItem("hearth_review_prompt_settled")
    ).toBeNull();

    // Not again in this app open, however long they keep using it.
    await spendTimeInApp(20 * MINUTE);
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("an X on the follow-up counts as 'Not yet', so it cannot nag every session", async () => {
    mockGetSignals.mockResolvedValue({
      ...ELIGIBLE_SIGNALS,
      awaitingRateConfirm: true,
    });
    await mountAndSettle();
    expect(
      screen.getByText("Did you get a chance to rate Hearth?")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mockRecordEvent).toHaveBeenCalledWith("rate_deferred");
    expect(
      window.localStorage.getItem("hearth_review_prompt_settled")
    ).toBeNull();
  });
});
