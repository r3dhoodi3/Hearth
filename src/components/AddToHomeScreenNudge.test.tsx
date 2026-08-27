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

// Simulates two page views (initial mount + one navigation, which is what
// the component counts) and lets the 5-second reveal timer run to completion.
async function mountTwoViewsAndAdvance() {
  mockPathname = "/dashboard";
  const utils = render(<AddToHomeScreenNudge />);
  mockPathname = "/documents";
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

  it("shows 5 seconds after the second page view, on iOS Safari, not standalone", async () => {
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

  it("dismisses forever once 'Got it' is tapped", async () => {
    await mountTwoViewsAndAdvance();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByText(HEADING)).toBeNull();
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe("1");

    // A fresh mount (e.g. after a reload) stays hidden even though the
    // view-count and route gates would otherwise be satisfied again.
    cleanup();
    mockPathname = "/dashboard";
    render(<AddToHomeScreenNudge />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("dismisses forever via the X as well", async () => {
    await mountTwoViewsAndAdvance();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(HEADING)).toBeNull();
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe("1");
  });
});
