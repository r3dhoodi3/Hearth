// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// next/link is a client component that needs a router context this test has no
// use for; a plain anchor is the same thing for every assertion here.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

import ProTrialNudge, { shouldShowOnVisit } from "./ProTrialNudge";
import { PRO_PLAN } from "@/lib/constants";

afterEach(() => cleanup());

beforeEach(() => {
  window.localStorage.clear();
});

const KEY = "hearth_pro_billing_visits:pro-1";

function renderNudge(eligible = true) {
  return render(<ProTrialNudge eligible={eligible} userId="pro-1" />);
}

function isShowing() {
  return screen.queryByTestId("pro-trial-nudge") !== null;
}

describe("ProTrialNudge visit schedule", () => {
  it("shows on visit 1 and then every tenth visit", () => {
    expect(shouldShowOnVisit(1)).toBe(true);
    for (let v = 2; v <= 10; v++) {
      expect(shouldShowOnVisit(v)).toBe(false);
    }
    expect(shouldShowOnVisit(11)).toBe(true);
    expect(shouldShowOnVisit(21)).toBe(true);
    expect(shouldShowOnVisit(31)).toBe(true);
    expect(shouldShowOnVisit(12)).toBe(false);
    expect(shouldShowOnVisit(0)).toBe(false);
  });

  it("appears on the first visit to billing", () => {
    renderNudge();
    expect(isShowing()).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");
  });

  it("stays away on visits 2 through 10", () => {
    for (let previous = 1; previous <= 9; previous++) {
      window.localStorage.setItem(KEY, String(previous));
      renderNudge();
      expect(isShowing(), `visit ${previous + 1}`).toBe(false);
      cleanup();
    }
  });

  it("comes back on visit 11", () => {
    window.localStorage.setItem(KEY, "10");
    renderNudge();
    expect(isShowing()).toBe(true);
  });

  it("does not reappear after a dismissal within the same visit", () => {
    renderNudge();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(isShowing()).toBe(false);
    // The count has already moved, so the next render is visit 2 and stays
    // quiet on its own.
    cleanup();
    renderNudge();
    expect(isShowing()).toBe(false);
  });

  it("never shows to a member or to a pro whose trial is spent", () => {
    renderNudge(false);
    expect(isShowing()).toBe(false);
    // And it does not quietly burn a visit either.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("counts per user, so a shared machine keeps two pros apart", () => {
    window.localStorage.setItem("hearth_pro_billing_visits:pro-2", "5");
    renderNudge();
    expect(isShowing()).toBe(true);
  });
});

describe("ProTrialNudge copy", () => {
  it("promises the trial length and the real price, and nothing the trial does not include", () => {
    renderNudge();
    const card = screen.getByTestId("pro-trial-nudge");
    expect(card).toHaveTextContent(
      `Try Hearth Pro free for ${PRO_PLAN.trialDays} days`
    );
    expect(card).toHaveTextContent(
      `${PRO_PLAN.trialDays} days free, then $${PRO_PLAN.monthly.toFixed(
        2
      )}/month. Cancel anytime.`
    );
    // The deposit boost and the monthly lead credit only start once the trial
    // converts to a paid month, so this card must never name them.
    expect(card.textContent ?? "").not.toMatch(/deposit|lead credit/i);
    expect(
      screen.getByRole("link", {
        name: `Start ${PRO_PLAN.trialDays} free days`,
      })
    ).toHaveAttribute("href", "/pro/plus");
  });
});
