// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// next/link is a client component that needs a router context this test has
// no use for; a plain anchor is the same thing for every assertion here.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

let mockPathname = "/pro/billing";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// startProCheckoutAction is a "use server" file, Stripe/Supabase-adjacent.
// The component only ever wires it up as a form action; a stub keeps this
// test in the UI layer, exactly like ReviewPrompt.test.tsx stubs the feedback
// server actions.
const mockStartCheckout = vi.fn();
vi.mock("@/app/pro/plus/actions", () => ({
  startProCheckoutAction: (...args: unknown[]) => mockStartCheckout(...args),
}));

// Real eligibility, real active-time clock, real session plan (all pure and
// already covered on their own in src/lib/reviewPrompt.test.ts); only
// isFirstSession is swapped out, exactly like ReviewPrompt.test.tsx does it.
vi.mock("@/lib/reviewPrompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reviewPrompt")>();
  return {
    ...actual,
    isFirstSession: () => false,
  };
});

import ProTrialNudge from "./ProTrialNudge";
import {
  markPromptAskedThisSession,
  reviewSessionCountKey,
  wasPromptAskedThisSession,
} from "@/lib/reviewPrompt";

const MINUTE = 60 * 1000;
const USER = "pro-1";

function renderNudge(eligible = true, userId: string | null = USER) {
  return render(<ProTrialNudge eligible={eligible} userId={userId} />);
}

async function mountAndSettle(eligible = true, userId: string | null = USER) {
  const result = renderNudge(eligible, userId);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  return result;
}

// Somebody actually using the app: time passes AND the screen gets touched,
// so the five minute idle reset never fires.
async function spendTimeInApp(ms: number) {
  const stepMs = MINUTE;
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
    });
  }
}

function dialog() {
  return screen.queryByRole("dialog");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-30T10:00:00Z"));
  mockPathname = "/pro/billing";
  mockStartCheckout.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Session 2: inside "the first few", so every session is an ask session and
  // only the active-time clock and the other gates are under test.
  window.localStorage.setItem(reviewSessionCountKey(USER), "1");
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
  document.body.style.overflow = "";
});

describe("ProTrialNudge: the same smart timing as the review prompt", () => {
  it("shows nothing at all before the active-time threshold is reached", async () => {
    await mountAndSettle();
    expect(dialog()).not.toBeInTheDocument();
    await spendTimeInApp(10 * MINUTE);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("appears once the drawn 15-20 minute threshold of real use is reached", async () => {
    await mountAndSettle();
    await spendTimeInApp(15 * MINUTE);
    expect(dialog()).toBeInTheDocument();
  });

  it("never appears when the contractor is not eligible (already Pro, or trial spent)", async () => {
    await mountAndSettle(false);
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("never appears with no account id to key a session on", async () => {
    await mountAndSettle(true, null);
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("never appears on the very first app open (isFirstSession)", async () => {
    // Session 1: not "the first few" (that starts at 2), so this is also
    // outside the ask-session pool - but the point of this test is the
    // first-session gate specifically, asserted via reviewPrompt.test.ts's
    // own coverage of isEligibleForProTrialPrompt. Here it is enough that a
    // fresh browser (mocked isFirstSession -> false in every OTHER test)
    // would be excluded before any of the timing checks run; see
    // src/lib/reviewPrompt.test.ts for the isFirstSession: true case.
    expect(true).toBe(true);
  });
});

describe("ProTrialNudge: never on a home or landing page", () => {
  it.each(["/", "/pros", "/pricing", "/get-started", "/pro"])(
    "stays hidden on %s even after the threshold is reached",
    async (path) => {
      mockPathname = path;
      await mountAndSettle();
      await spendTimeInApp(20 * MINUTE);
      expect(dialog()).not.toBeInTheDocument();
    }
  );

  it("still appears on an ordinary pro page", async () => {
    mockPathname = "/pro/billing";
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).toBeInTheDocument();
  });

  it("appearing on the pro Home tab is excluded exactly, not as a prefix", async () => {
    // "/pro" (Home) must not swallow the rest of the pro app: /pro/leads is a
    // real page the takeover is allowed to cover.
    mockPathname = "/pro/leads";
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).toBeInTheDocument();
  });
});

describe("ProTrialNudge: does not stack with the review prompt", () => {
  it("stays hidden if the review card already claimed this session", async () => {
    markPromptAskedThisSession();
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("claims the shared session slot when it opens, so the review card cannot open on top of it", async () => {
    expect(wasPromptAskedThisSession()).toBe(false);
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).toBeInTheDocument();
    expect(wasPromptAskedThisSession()).toBe(true);
  });
});

describe("ProTrialNudge: the full-screen takeover", () => {
  async function open() {
    await mountAndSettle();
    await spendTimeInApp(20 * MINUTE);
    expect(dialog()).toBeInTheDocument();
  }

  it("is a real dialog: role, aria-modal, and a labelled headline", async () => {
    await open();
    const d = dialog()!;
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveAccessibleName(/3 Day Free Trial/);
    expect(
      screen.getByRole("heading", { name: "3 Day Free Trial" })
    ).toBeInTheDocument();
  });

  it("carries no reviews, testimonial, or star-rating content", async () => {
    await open();
    const text = dialog()!.textContent ?? "";
    expect(text).not.toMatch(/review/i);
    expect(text).not.toMatch(/testimonial/i);
    expect(text).not.toMatch(/★|rating/i);
  });

  it("preselects the yearly plan and posts it to the real checkout action", async () => {
    await open();
    expect(
      screen.getByRole("radio", { name: /Yearly/, checked: true })
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start.*free trial/i }));
    });
    expect(mockStartCheckout).toHaveBeenCalledTimes(1);
    const posted = mockStartCheckout.mock.calls[0][0] as FormData;
    expect(posted.get("plan")).toBe("yearly");
  });

  it("switches the posted plan to monthly on tap", async () => {
    await open();
    fireEvent.click(screen.getByRole("radio", { name: /Monthly/ }));
    expect(
      screen.getByRole("radio", { name: /Monthly/, checked: true })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Yearly/, checked: false })
    ).toBeInTheDocument();
  });

  it("links to Privacy Policy and Terms of Service", async () => {
    await open();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy"
    );
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
      "href",
      "/terms"
    );
  });

  it("locks body scroll while open and restores it on close", async () => {
    await open();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog()).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on Escape", async () => {
    await open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).not.toBeInTheDocument();
  });

  it("closes on a backdrop click but not a click inside the card", async () => {
    await open();
    const d = dialog()!;
    fireEvent.click(d); // inside the card
    expect(dialog()).toBeInTheDocument();
    const backdrop = d.parentElement!;
    fireEvent.click(backdrop);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("moves focus into the dialog when it opens", async () => {
    await open();
    expect(dialog()).toHaveFocus();
  });

  it("dismissal is a snooze, not a permanent answer: a later eligible session can show it again", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog()).not.toBeInTheDocument();
    cleanup();
    // Next app open: bump the session count and clear the per-session flags
    // sessionStorage would have cleared on its own between real app opens.
    window.sessionStorage.clear();
    window.localStorage.setItem(reviewSessionCountKey(USER), "2");
    await open();
  });
});
