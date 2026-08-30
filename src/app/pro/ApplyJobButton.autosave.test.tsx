// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same reasoning as ApplyJobButton.test.tsx: applyToJobAction pulls in the
// service-role Supabase client at module scope, unimportable in a test
// process. Kept in its own file (separate from ApplyJobButton.test.tsx,
// which covers the 0149 pricing/confirm-copy block) so this autosave-only
// change never collides with that one.
vi.mock("./actions", () => ({ applyToJobAction: vi.fn() }));

import ApplyJobButton from "./ApplyJobButton";
import {
  DRAFT_SAVE_DEBOUNCE_MS,
  readComposeDraft,
} from "@/lib/proComposeDraft";

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

// CR5#4: the apply-message textarea survives a dropped signal or a
// backgrounded app on a job site, the same idea as the tool drafts
// (ProToolsClient.test.tsx) and the CRM note (CrmView.test.tsx).
describe("ApplyJobButton: apply-message autosave", () => {
  function openConfirm(leadId: string) {
    render(<ApplyJobButton leadId={leadId} fee="$45" canAfford={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply · $45" }));
    return screen.getByPlaceholderText("Add a note to the homeowner (optional)");
  }

  it("saves the typed note debounced and restores it after remount", () => {
    vi.useFakeTimers();
    const field = openConfirm("lead-autosave-1");
    fireEvent.change(field, {
      target: { value: "Hi, I can take a look Thursday" },
    });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("apply", "lead-autosave-1")).toBe(
      "Hi, I can take a look Thursday"
    );
    cleanup();

    render(<ApplyJobButton leadId="lead-autosave-1" fee="$45" canAfford={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply · $45" }));
    expect(
      screen.getByPlaceholderText("Add a note to the homeowner (optional)")
    ).toHaveValue("Hi, I can take a look Thursday");
    vi.useRealTimers();
  });

  it("keeps two leads' drafts apart", () => {
    vi.useFakeTimers();
    const fieldA = openConfirm("lead-a");
    fireEvent.change(fieldA, { target: { value: "Note for lead A" } });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    cleanup();

    const fieldB = openConfirm("lead-b");
    fireEvent.change(fieldB, { target: { value: "Note for lead B" } });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);

    expect(readComposeDraft("apply", "lead-a")).toBe("Note for lead A");
    expect(readComposeDraft("apply", "lead-b")).toBe("Note for lead B");
    vi.useRealTimers();
  });

  it("clears the draft once the confirm form submits", () => {
    vi.useFakeTimers();
    const field = openConfirm("lead-submit");
    fireEvent.change(field, { target: { value: "Ready to send" } });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("apply", "lead-submit")).toBe("Ready to send");

    fireEvent.submit(field.closest("form")!);
    expect(readComposeDraft("apply", "lead-submit")).toBe("");
    vi.useRealTimers();
  });
});
