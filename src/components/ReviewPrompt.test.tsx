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

// Real isEligibleForReviewPrompt/isExcludedPath (they're pure and already
// covered on their own in src/lib/reviewPrompt.test.ts); only the two
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

const ELIGIBLE_SIGNALS = {
  alreadyShownOrAnswered: false,
  hasMeaningfulActivity: true,
};

async function renderAndWaitForCard() {
  render(<ReviewPrompt />);
  // The component starts a 3s timer AND a signals fetch on mount; advancing
  // time also flushes the microtasks the resolved fetch promise queues, so
  // this one call is enough for both halves of maybeShow() to have run.
  // Wrapped in act() because the state update lands from a fake-timer
  // callback, outside of any render/event that testing-library wraps itself.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPathname = "/dashboard";
  mockGetSignals.mockReset().mockResolvedValue(ELIGIBLE_SIGNALS);
  mockRecordEvent.mockReset().mockResolvedValue(undefined);
  mockPush.mockReset();
  mockRequestNativeReview.mockReset();
  delete process.env.NEXT_PUBLIC_APP_STORE_URL;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ReviewPrompt: nothing renders before it is eligible", () => {
  it("renders nothing at all before the 3 second delay elapses", async () => {
    render(<ReviewPrompt />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("never fetches or shows on an excluded page", async () => {
    mockPathname = "/feedback";
    await renderAndWaitForCard();
    expect(mockGetSignals).not.toHaveBeenCalled();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("stays hidden when the account was already shown or answered", async () => {
    mockGetSignals.mockResolvedValue({
      alreadyShownOrAnswered: true,
      hasMeaningfulActivity: true,
    });
    await renderAndWaitForCard();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });

  it("stays hidden when the account has done nothing meaningful yet", async () => {
    mockGetSignals.mockResolvedValue({
      alreadyShownOrAnswered: false,
      hasMeaningfulActivity: false,
    });
    await renderAndWaitForCard();
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
  });
});

describe("ReviewPrompt: shown -> love -> rate step", () => {
  it("shows the card, then Love it moves to the thank-you step", async () => {
    await renderAndWaitForCard();
    expect(screen.getByText("Enjoying Hearth?")).toBeInTheDocument();
    // Showing the card is itself an event, logged before any button is
    // pressed - this is what makes "at most once" hold for a silent dismiss.
    expect(mockRecordEvent).toHaveBeenCalledWith("prompt_shown");

    fireEvent.click(screen.getByRole("button", { name: "Love it" }));

    expect(mockRecordEvent).toHaveBeenCalledWith("loved");
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(screen.getByText("Rate Hearth")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Thank you. A quick rating helps other homeowners find Hearth."
      )
    ).toBeInTheDocument();
    // Never the native store prompt, and never a browser confirm/alert.
    expect(mockRequestNativeReview).not.toHaveBeenCalled();
  });

  it("shows the App Store link when NEXT_PUBLIC_APP_STORE_URL is set, and calls the native hook on tap", async () => {
    process.env.NEXT_PUBLIC_APP_STORE_URL = "https://apps.apple.com/app/hearth";
    await renderAndWaitForCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));

    const link = screen.getByRole("link", { name: "Rate on the App Store" });
    expect(link).toHaveAttribute("href", "https://apps.apple.com/app/hearth");

    fireEvent.click(link);
    expect(mockRequestNativeReview).toHaveBeenCalledTimes(1);
  });

  it("hides the App Store button entirely when the env var is unset", async () => {
    await renderAndWaitForCard();
    fireEvent.click(screen.getByRole("button", { name: "Love it" }));
    expect(
      screen.queryByRole("link", { name: "Rate on the App Store" })
    ).not.toBeInTheDocument();
  });
});

describe("ReviewPrompt: shown -> not really -> navigates to /feedback", () => {
  it("logs 'not_really' and routes to /feedback without ever showing a rate step", async () => {
    await renderAndWaitForCard();
    fireEvent.click(screen.getByRole("button", { name: "Not really" }));

    expect(mockRecordEvent).toHaveBeenCalledWith("not_really");
    expect(mockPush).toHaveBeenCalledWith("/feedback");
    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    expect(screen.queryByText("Rate Hearth")).not.toBeInTheDocument();
  });
});

describe("ReviewPrompt: dismiss", () => {
  it("the X closes the card and counts as answered with no extra write", async () => {
    await renderAndWaitForCard();
    const callsBeforeDismiss = mockRecordEvent.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Enjoying Hearth?")).not.toBeInTheDocument();
    // 'prompt_shown' already recorded when the card appeared; dismissing
    // itself writes nothing further.
    expect(mockRecordEvent.mock.calls.length).toBe(callsBeforeDismiss);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
