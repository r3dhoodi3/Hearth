// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PostJobDoneReferralAsk from "./PostJobDoneReferralAsk";

const SEEN_KEY = "hearth_postjob_referral_seen";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("PostJobDoneReferralAsk", () => {
  it("renders nothing when there is no code", () => {
    const { container } = render(<PostJobDoneReferralAsk code={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the one-line ask the first time, with a code", async () => {
    render(<PostJobDoneReferralAsk code="ABCD1234" />);
    await waitFor(() =>
      expect(
        screen.getByText("Know a neighbour with the same problem? Share Hearth.")
      ).toBeInTheDocument()
    );
  });

  it("marks itself seen once shown, so a later mount stays hidden", async () => {
    const first = render(<PostJobDoneReferralAsk code="ABCD1234" />);
    await waitFor(() => expect(screen.getByText("Share")).toBeInTheDocument());
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("1");
    first.unmount();

    const second = render(<PostJobDoneReferralAsk code="ABCD1234" />);
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });

  it("shares the invite link, falling back to clipboard with no native share", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    render(<PostJobDoneReferralAsk code="ABCD1234" />);
    await waitFor(() => expect(screen.getByText("Share")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Share"));
    await waitFor(() => expect(screen.getByText("Link copied")).toBeInTheDocument());
  });
});
