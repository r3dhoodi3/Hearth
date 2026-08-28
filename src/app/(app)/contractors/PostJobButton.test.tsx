// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PostJobButton from "./PostJobButton";

afterEach(() => {
  cleanup();
});

// check() reads the "message" and "issue_id" fields straight off the DOM via
// form.elements, so these fixtures stand in for the real page's textarea and
// hidden input without needing DescriptionField/CategoryFilter mounted.
function Fixture({
  message = "",
  issueId = "",
  serverError = null,
  onSubmit,
}: {
  message?: string;
  issueId?: string;
  serverError?: string | null;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit}>
      <input type="hidden" name="issue_id" defaultValue={issueId} />
      <textarea name="message" defaultValue={message} />
      <PostJobButton serverError={serverError} />
    </form>
  );
}

function renderForm(props: {
  message?: string;
  issueId?: string;
  serverError?: string | null;
} = {}) {
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  const view = render(<Fixture {...props} onSubmit={onSubmit} />);
  return {
    onSubmit,
    // Re-renders the SAME mounted component with a new serverError, which is
    // what a failure redirect back to /contractors?...&error=... actually
    // does: the form's key is ?posted=, unchanged by that redirect, so React
    // updates this subtree rather than remounting it.
    setServerError(serverError: string | null) {
      view.rerender(
        <Fixture {...props} serverError={serverError} onSubmit={onSubmit} />
      );
    },
  };
}

describe("PostJobButton", () => {
  it("blocks submit and shows an error when the message is under 20 characters", () => {
    const { onSubmit } = renderForm({ message: "too short" });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "at least 20 characters"
    );
  });

  it("allows submit once the message reaches 20 characters", () => {
    const { onSubmit } = renderForm({
      message: "Fix the leaky kitchen faucet please",
    });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows a blank message when the post is linked to an issue", () => {
    const { onSubmit } = renderForm({ message: "", issueId: "issue-123" });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still blocks a short (non-empty) message even when linked to an issue", () => {
    const { onSubmit } = renderForm({ message: "short", issueId: "issue-123" });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  // The server half of the same slot: postJobAction sends a rejected post back
  // to /contractors with an ?error= code, and the page resolves it into this
  // prop. Before this existed, a rejected post reset the form with nothing on
  // screen to explain it.
  it("shows the reason the last attempt was rejected", () => {
    renderForm({
      message: "Fix the leaky kitchen faucet please",
      serverError: "Please pick a valid job category.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please pick a valid job category."
    );
  });

  // THE REAL SEQUENCE, and the one the old `staleServerError` latch broke.
  // A passing submit is followed by a redirect back to this same page with a
  // new ?error= code, which re-renders this component with a NEW serverError
  // prop - the form's key is ?posted=, which a failure redirect never changes,
  // so there is no remount to reset any latch. The message MUST show.
  it("shows a new server message that arrives after a passing submit", () => {
    const { onSubmit, setServerError } = renderForm({
      message: "Fix the leaky kitchen faucet please",
    });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    setServerError("Please pick a valid job category.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please pick a valid job category."
    );
  });

  // The same thing twice in a row: two rejected posts with the same reason
  // must both say so, not just the first one.
  it("shows the server message again on a second rejected attempt", () => {
    const { setServerError } = renderForm({
      message: "Fix the leaky kitchen faucet please",
      serverError: "Please pick a valid job category.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    setServerError("Please pick a valid job category.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please pick a valid job category."
    );
  });

  // While the post is genuinely in flight the previous attempt's reason is
  // about the OLD submit, so it is hidden for exactly that long - and only
  // that long. A real form action is used here so useFormStatus reports the
  // pending it would report in the browser.
  it("hides the server message only while a submit is in flight", async () => {
    let release: (() => void) | null = null;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    render(
      <form action={action}>
        <input type="hidden" name="issue_id" defaultValue="" />
        <textarea
          name="message"
          defaultValue="Fix the leaky kitchen faucet please"
        />
        <PostJobButton serverError="Please pick a valid job category." />
      </form>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Posting…" })).toBeDisabled();

    release!();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("the client-side check wins over a stale server message", () => {
    const { onSubmit } = renderForm({
      message: "short",
      serverError: "Please pick a valid job category.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "at least 20 characters"
    );
  });

  it("clears a previous error once the message is long enough", () => {
    renderForm({ message: "short" });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const button = screen.getByRole("button", { name: "Post job" });
    fireEvent.click(button);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.change(textarea, {
      target: { value: "Now this description is long enough to pass" },
    });
    fireEvent.click(button);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
