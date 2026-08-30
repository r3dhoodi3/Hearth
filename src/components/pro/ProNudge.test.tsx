// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import ProNudge, { dismissedToday, epochDay, nudgeKey } from "./ProNudge";

// The membership nudge on the pro Home tab. The rule worth testing is the one
// the owner asked for: "a little annoying" means it comes back TOMORROW after
// a dismissal, not on the next page view, and never within the same day.

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("dismissedToday", () => {
  const now = Date.UTC(2026, 7, 30, 12, 0, 0);

  it("is false with nothing stored", () => {
    expect(dismissedToday(null, now)).toBe(false);
    expect(dismissedToday("", now)).toBe(false);
    expect(dismissedToday("not a number", now)).toBe(false);
  });

  it("is true for a dismissal stamped today", () => {
    expect(dismissedToday(String(epochDay(now)), now)).toBe(true);
  });

  it("is false again the next day", () => {
    const stamp = String(epochDay(now));
    const tomorrow = now + 86_400_000;
    expect(dismissedToday(stamp, tomorrow)).toBe(false);
  });

  it("stays dismissed for the rest of the same day", () => {
    const stamp = String(epochDay(now));
    expect(dismissedToday(stamp, now + 6 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("ProNudge", () => {
  it("renders the perks in plain numbers with the trial label", () => {
    render(
      <ProNudge
        userId="u1"
        trialEligible
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    expect(screen.getByText(/\+5% bonus on every deposit/)).toBeInTheDocument();
    expect(screen.getByText(/\$10 of lead credit every month/)).toBeInTheDocument();
    // The shared CTA label, so the trial length can never drift from checkout.
    expect(screen.getByText(/Try Pro free for/)).toBeInTheDocument();
  });

  it("says 'See Hearth Pro' when there is no trial to offer", () => {
    render(
      <ProNudge
        userId="u1"
        trialEligible={false}
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    expect(screen.getByText("See Hearth Pro")).toBeInTheDocument();
  });

  it("hides itself for the rest of the day when dismissed, and stamps the day", () => {
    render(
      <ProNudge
        userId="u1"
        trialEligible
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    fireEvent.click(screen.getByLabelText("Hide this for today"));
    expect(screen.queryByText("Hearth Pro")).toBeNull();
    expect(window.localStorage.getItem(nudgeKey("u1"))).toBe(
      String(epochDay())
    );
  });

  it("stays hidden on a remount the same day", () => {
    window.localStorage.setItem(nudgeKey("u1"), String(epochDay()));
    render(
      <ProNudge
        userId="u1"
        trialEligible
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    expect(screen.queryByText("Hearth Pro")).toBeNull();
  });

  it("comes back the next day", () => {
    window.localStorage.setItem(nudgeKey("u1"), String(epochDay() - 1));
    render(
      <ProNudge
        userId="u1"
        trialEligible
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    expect(screen.getByText("Hearth Pro")).toBeInTheDocument();
  });

  it("keeps one pro's dismissal out of another's", () => {
    window.localStorage.setItem(nudgeKey("u1"), String(epochDay()));
    render(
      <ProNudge
        userId="u2"
        trialEligible
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    expect(screen.getByText("Hearth Pro")).toBeInTheDocument();
  });

  it("gives the dismiss control a real tap target", () => {
    const { container } = render(
      <ProNudge
        userId="u1"
        trialEligible
        depositBoostPts={5}
        monthlyCreditDollars={10}
      />
    );
    const close = container.querySelector('button[aria-label="Hide this for today"]');
    expect(close?.className).toContain("h-11");
    expect(close?.className).toContain("w-11");
  });
});
