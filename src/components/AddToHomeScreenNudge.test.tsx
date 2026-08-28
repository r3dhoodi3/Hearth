// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The component reads the current route via usePathname to (a) count page
// views and (b) skip excluded flows. Mocked to a mutable module-level value
// so a test can simulate navigating from one page view to the next.
let mockPathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import AddToHomeScreenNudge from "./AddToHomeScreenNudge";

const HEADING = "Add Hearth to your Home Screen";
const DISMISSED_KEY = "hearth_a2hs_dismissed";
const SNOOZE_KEY = "hearth_a2hs_snoozed_until";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const IOS_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function setStandalone(value: boolean | undefined) {
  Object.defineProperty(window.navigator, "standalone", {
    value,
    configurable: true,
  });
}

// Simulates the earliest moment the nudge is allowed to appear: three page
// views, of which TWO are the dashboard (the first dashboard visit is spoken
// for by the app guide and the alerts), then the 5-second reveal timer.
async function mountTwoViewsAndAdvance() {
  mockPathname = "/dashboard";
  const utils = render(<AddToHomeScreenNudge />);
  mockPathname = "/documents";
  utils.rerender(<AddToHomeScreenNudge />);
  mockPathname = "/dashboard";
  utils.rerender(<AddToHomeScreenNudge />);
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  return utils;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  setUserAgent(IOS_SAFARI_UA);
  setStandalone(false);
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: 5,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("AddToHomeScreenNudge", () => {
  it("stays hidden on the first page view even on a qualifying browser", async () => {
    mockPathname = "/dashboard";
    render(<AddToHomeScreenNudge />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  // The reported problem: it fired on the very first dashboard, on top of the
  // app guide and the alerts that already run there. Browsing two other pages
  // is not enough - the second DASHBOARD visit is the gate.
  it("stays hidden through a first dashboard visit and a second page elsewhere", async () => {
    mockPathname = "/dashboard";
    const { rerender } = render(<AddToHomeScreenNudge />);
    mockPathname = "/documents";
    rerender(<AddToHomeScreenNudge />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("shows 5 seconds into the second dashboard visit, on iOS Safari, not standalone", async () => {
    await mountTwoViewsAndAdvance();
    expect(screen.getByText(HEADING)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Tap Share, then Add to Home Screen. It opens like an app, full screen."
      )
    ).toBeInTheDocument();
  });

  it("never shows on Android Chrome", async () => {
    setUserAgent(ANDROID_CHROME_UA);
    await mountTwoViewsAndAdvance();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("never shows on Chrome for iOS, even though its UA also contains Safari", async () => {
    setUserAgent(IOS_CHROME_UA);
    await mountTwoViewsAndAdvance();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("never shows once the app is already installed (standalone)", async () => {
    setStandalone(true);
    await mountTwoViewsAndAdvance();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("never shows on an excluded path like /signin", async () => {
    mockPathname = "/signin";
    const { rerender } = render(<AddToHomeScreenNudge />);
    mockPathname = "/signin/verify";
    rerender(<AddToHomeScreenNudge />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  // The reported problem: the card is fixed to the bottom of the phone
  // screen, right where the Ask Hearth and chat composers live, so it popped
  // up mid-answer and covered the input. There is no global "request in
  // flight" signal to gate on instead, so the whole route is excluded on
  // both sides of the app.
  it.each(["/ask", "/pro/ask", "/chats", "/pro/chats"])(
    "never shows on %s or a thread nested under it",
    async (path) => {
      mockPathname = path;
      const { rerender } = render(<AddToHomeScreenNudge />);
      mockPathname = `${path}/some-thread-id`;
      rerender(<AddToHomeScreenNudge />);
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByText(HEADING)).toBeNull();
    }
  );

  it("snoozes for a week once 'Got it' is tapped", async () => {
    await mountTwoViewsAndAdvance();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByText(HEADING)).toBeNull();
    const until = Number(window.localStorage.getItem(SNOOZE_KEY));
    expect(until).toBeGreaterThan(Date.now() + WEEK_MS - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + WEEK_MS);

    // A fresh mount (e.g. after a reload) stays hidden even though the
    // view-count and route gates would otherwise be satisfied again.
    cleanup();
    await mountTwoViewsAndAdvance();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("comes back once the week is up", async () => {
    await mountTwoViewsAndAdvance();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    cleanup();

    vi.setSystemTime(new Date(Date.now() + WEEK_MS + 1000));
    await mountTwoViewsAndAdvance();

    expect(screen.getByText(HEADING)).toBeInTheDocument();
  });

  it("snoozes via the X as well", async () => {
    await mountTwoViewsAndAdvance();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(HEADING)).toBeNull();
    expect(Number(window.localStorage.getItem(SNOOZE_KEY))).toBeGreaterThan(
      Date.now()
    );
  });

  // Anyone who dismissed this under the old forever-dismiss behavior keeps
  // that answer: the legacy flag is still read, it is just no longer written.
  it("still honors a legacy forever-dismissed flag", async () => {
    window.localStorage.setItem(DISMISSED_KEY, "1");
    await mountTwoViewsAndAdvance();
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  // The bar it must never cover is the phone tab bar (Home / Post /
  // Messages), which is 48px of content plus the notch inset. jsdom applies
  // no CSS, so the offset class itself is the thing to assert.
  it("sits clear of the bottom tab bar", async () => {
    const { getByTestId } = await mountTwoViewsAndAdvance();
    expect(getByTestId("a2hs-nudge").className).toContain(
      "bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)]"
    );
  });
});
