// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PostJobButton from "./PostJobButton";

afterEach(() => {
  cleanup();
});

// check() reads the "message" and "issue_id" fields straight off the DOM via
// form.elements, so these fixtures stand in for the real page's textarea and
// hidden input without needing DescriptionField/CategoryFilter mounted.
function renderForm({
  message = "",
  issueId = "",
}: {
  message?: string;
  issueId?: string;
} = {}) {
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <input type="hidden" name="issue_id" defaultValue={issueId} />
      <textarea name="message" defaultValue={message} />
      <PostJobButton />
    </form>
  );
  return onSubmit;
}

describe("PostJobButton", () => {
  it("blocks submit and shows an error when the message is under 20 characters", () => {
    const onSubmit = renderForm({ message: "too short" });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "at least 20 characters"
    );
  });

  it("allows submit once the message reaches 20 characters", () => {
    const onSubmit = renderForm({
      message: "Fix the leaky kitchen faucet please",
    });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows a blank message when the post is linked to an issue", () => {
    const onSubmit = renderForm({ message: "", issueId: "issue-123" });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still blocks a short (non-empty) message even when linked to an issue", () => {
    const onSubmit = renderForm({ message: "short", issueId: "issue-123" });
    fireEvent.click(screen.getByRole("button", { name: "Post job" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
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
