// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import CategoryFilter from "./CategoryFilter";
import PhotoTips from "@/components/PhotoTips";
import PostJobButton from "./PostJobButton";

afterEach(() => {
  cleanup();
});

// Regression test for the second cause of the silent Post-job failure:
// PhotoTips watches the form for "category" changes, but on this page
// `name="category"` is a hidden <input> CategoryFilter writes via React
// state - a value React sets programmatically fires no native DOM event, so
// PhotoTips only ever caught up whenever some OTHER field (the description
// textarea, on blur) happened to fire its own change/input event, mounting
// a ~130px tips block right as a tap on Post job was in flight. The fix
// defers the read past the same tick React commits the hidden input, and
// also listens for "input" (debounced) so typing elsewhere resyncs it too.
describe("PhotoTips mount timing (post-a-job form)", () => {
  it("mounts once a category is picked, stays mounted while typing, and blur adds no new node above the Post button", async () => {
    render(
      <form>
        <CategoryFilter category="" id="job-category" />
        <textarea name="message" aria-label="message" />
        <PhotoTips />
        <PostJobButton />
      </form>
    );

    // No category picked yet: no tips block at all.
    expect(screen.queryByText("Good shots to include")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "plumbing" },
    });

    // Settles quickly (the fix's deferred read), long before any typing or
    // tap on Post job - not waiting on some later, unrelated blur.
    await waitFor(() => {
      expect(screen.getByText("Good shots to include")).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText("message");
    fireEvent.input(textarea, {
      target: { value: "Need someone to fix a leaky kitchen faucet" },
    });

    // Still mounted while typing, well before any blur.
    expect(screen.getByText("Good shots to include")).toBeInTheDocument();

    const formEl = screen.getByRole("combobox").closest("form")!;
    const nodeCountBeforeBlur = formEl.querySelectorAll("*").length;

    fireEvent.blur(textarea);

    // Blurring the description must not mount (or remove) anything: the
    // tips block was already settled at category-pick time.
    const nodeCountAfterBlur = formEl.querySelectorAll("*").length;
    expect(nodeCountAfterBlur).toBe(nodeCountBeforeBlur);
    expect(screen.getByText("Good shots to include")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post job" })).toBeInTheDocument();
  });
});
