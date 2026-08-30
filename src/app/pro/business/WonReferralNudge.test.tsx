// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import WonReferralNudge from "./WonReferralNudge";

const SEEN_KEY = "hearth_won_referral_nudge_seen";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("WonReferralNudge (MR3#12, pro side)", () => {
  it("renders nothing before the first Won lead", () => {
    const { container } = render(<WonReferralNudge wonCount={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the nudge, linking to the account panel, after the first Won lead", async () => {
    render(<WonReferralNudge wonCount={1} />);
    await waitFor(() =>
      expect(
        screen.getByText("Who else should be on Hearth? Refer another pro.")
      ).toBeInTheDocument()
    );
    const link = screen.getByText("See your referral link");
    expect(link.closest("a")).toHaveAttribute("href", "/pro/business#account");
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("1");
  });

  it("stays hidden on a later mount once already seen", async () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    const { container } = render(<WonReferralNudge wonCount={3} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
