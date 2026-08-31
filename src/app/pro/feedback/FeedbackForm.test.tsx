// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The real module is a "use server" file; the component only ever awaits it.
const submitProFeedbackAction = vi.fn();
vi.mock("./actions", () => ({
  submitProFeedbackAction: (...a: unknown[]) => submitProFeedbackAction(...a),
}));

import FeedbackForm from "./FeedbackForm";
import {
  FEEDBACK_DEAL_NOTE,
  FEEDBACK_REPEAT_NOTE,
  FEEDBACK_LOCKED_NOTE,
  FEEDBACK_CREDITED_NOTE,
  FEEDBACK_THANKS_NOTE,
} from "@/lib/proFeedback";

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

const GOOD = "The wallet page shows the wrong balance after a refund.";

// Fill the two required inputs and press send.
function fillAndSubmit() {
  fireEvent.click(screen.getByRole("button", { name: /4\s*Good/ }));
  fireEvent.change(screen.getByLabelText("What happened, or what should we build?"), {
    target: { value: GOOD },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send it" }));
}

describe("pro FeedbackForm: the deal is stated before the tap", () => {
  it("tells a first-timer the first report pays instantly and later ones do not", () => {
    render(<FeedbackForm established claimed={false} />);
    expect(screen.getByText(FEEDBACK_DEAL_NOTE)).toBeInTheDocument();
  });

  it("tells an unqualified pro when the credit unlocks", () => {
    render(<FeedbackForm established={false} claimed={false} />);
    expect(screen.getByText(FEEDBACK_LOCKED_NOTE)).toBeInTheDocument();
  });

  it("never re-promises the credit once it is claimed", () => {
    render(<FeedbackForm established claimed />);
    expect(screen.getByText(FEEDBACK_REPEAT_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(FEEDBACK_DEAL_NOTE)).not.toBeInTheDocument();
  });
});

describe("pro FeedbackForm: the three success screens", () => {
  it("says the credit landed when THIS submission earned it", async () => {
    submitProFeedbackAction.mockResolvedValue({
      ok: true,
      data: { outcome: "credited" },
    });
    render(<FeedbackForm established claimed={false} />);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText(FEEDBACK_CREDITED_NOTE)).toBeInTheDocument()
    );
    expect(
      screen.getByRole("link", { name: "See my wallet" })
    ).toHaveAttribute("href", "/pro/billing");
  });

  it("thanks a later report with no credit language", async () => {
    submitProFeedbackAction.mockResolvedValue({
      ok: true,
      data: { outcome: "thanks" },
    });
    render(<FeedbackForm established claimed />);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText(FEEDBACK_THANKS_NOTE)).toBeInTheDocument()
    );
    // No money promised and no wallet link: the deal said later reports do
    // not pay on their own, and the confirmation must not contradict it.
    expect(screen.queryByText(FEEDBACK_CREDITED_NOTE)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "See my wallet" })
    ).not.toBeInTheDocument();
    // And the door stays open for the next one.
    expect(
      screen.getByRole("button", { name: "Report another bug" })
    ).toBeInTheDocument();
  });

  it("explains the waiting credit for an unqualified first report", async () => {
    submitProFeedbackAction.mockResolvedValue({
      ok: true,
      data: { outcome: "locked" },
    });
    render(<FeedbackForm established={false} claimed={false} />);
    fillAndSubmit();
    await waitFor(() =>
      // Both the pre-submit note and the confirmation carry the same line.
      expect(screen.getAllByText(FEEDBACK_LOCKED_NOTE).length).toBeGreaterThan(0)
    );
    expect(screen.queryByText(FEEDBACK_CREDITED_NOTE)).not.toBeInTheDocument();
  });

  it("keeps the typed note on screen when the server refuses", async () => {
    submitProFeedbackAction.mockResolvedValue({
      ok: false,
      error: "We could not save your report. Please try again in a moment.",
    });
    render(<FeedbackForm established claimed={false} />);
    fillAndSubmit();
    await waitFor(() =>
      expect(
        screen.getByText(
          "We could not save your report. Please try again in a moment."
        )
      ).toBeInTheDocument()
    );
    expect(
      screen.getByLabelText("What happened, or what should we build?")
    ).toHaveValue(GOOD);
  });
});
