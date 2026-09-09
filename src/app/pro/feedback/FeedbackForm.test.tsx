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
import { FEEDBACK_PENDING_NOTE } from "@/lib/proFeedback";

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

describe("pro FeedbackForm: the deal is stated before the tap (C7, 2026-09-07)", () => {
  it("states the one honest sentence before anyone types", () => {
    render(<FeedbackForm />);
    expect(screen.getByText(FEEDBACK_PENDING_NOTE)).toBeInTheDocument();
  });

  it("never promises a dollar amount before review", () => {
    render(<FeedbackForm />);
    // No stray "$5" or "instantly" language anywhere on the fresh form.
    expect(screen.queryByText(/\$5/)).not.toBeInTheDocument();
    expect(screen.queryByText(/instantly/i)).not.toBeInTheDocument();
  });
});

describe("pro FeedbackForm: after submit", () => {
  it("confirms with the same pending-review sentence, no wallet link", async () => {
    submitProFeedbackAction.mockResolvedValue({
      ok: true,
      data: { outcome: "pending" },
    });
    render(<FeedbackForm />);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getAllByText(FEEDBACK_PENDING_NOTE).length).toBeGreaterThan(0)
    );
    // Nothing pays automatically, so there is no "see my wallet" link here.
    expect(
      screen.queryByRole("link", { name: "See my wallet" })
    ).not.toBeInTheDocument();
    // And the door stays open for the next one.
    expect(
      screen.getByRole("button", { name: "Report another bug" })
    ).toBeInTheDocument();
  });

  it("keeps the typed note on screen when the server refuses", async () => {
    submitProFeedbackAction.mockResolvedValue({
      ok: false,
      error: "We could not save your report. Please try again in a moment.",
    });
    render(<FeedbackForm />);
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
