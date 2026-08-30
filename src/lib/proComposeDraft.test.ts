// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  readComposeDraft,
  saveComposeDraftDebounced,
  clearComposeDraft,
  DRAFT_SAVE_DEBOUNCE_MS,
} from "./proComposeDraft";

describe("proComposeDraft", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it("reads nothing before anything is saved", () => {
    expect(readComposeDraft("apply", "lead-1")).toBe("");
  });

  it("does not read or write without an id", () => {
    saveComposeDraftDebounced("apply", "", "hello");
    expect(readComposeDraft("apply", "")).toBe("");
  });

  it("saves after the debounce window and restores it", async () => {
    vi.useFakeTimers();
    saveComposeDraftDebounced("apply", "lead-1", "On my way");
    // Not written yet: the debounce hasn't elapsed.
    expect(readComposeDraft("apply", "lead-1")).toBe("");
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("apply", "lead-1")).toBe("On my way");
    vi.useRealTimers();
  });

  it("keeps two different ids of the same kind apart", () => {
    vi.useFakeTimers();
    saveComposeDraftDebounced("tool", "estimate", "leaking pipe");
    saveComposeDraftDebounced("tool", "invoice", "replaced water heater");
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("tool", "estimate")).toBe("leaking pipe");
    expect(readComposeDraft("tool", "invoice")).toBe("replaced water heater");
    vi.useRealTimers();
  });

  it("collapses rapid typing into one write, not one per keystroke", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    saveComposeDraftDebounced("apply", "lead-1", "O");
    vi.advanceTimersByTime(50);
    saveComposeDraftDebounced("apply", "lead-1", "On");
    vi.advanceTimersByTime(50);
    saveComposeDraftDebounced("apply", "lead-1", "On my way");
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(readComposeDraft("apply", "lead-1")).toBe("On my way");
    setSpy.mockRestore();
    vi.useRealTimers();
  });

  it("clears a saved draft immediately, cancelling anything pending", () => {
    vi.useFakeTimers();
    saveComposeDraftDebounced("apply", "lead-1", "typed something");
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("apply", "lead-1")).toBe("typed something");
    clearComposeDraft("apply", "lead-1");
    expect(readComposeDraft("apply", "lead-1")).toBe("");
    vi.useRealTimers();
  });

  it("saving an emptied box removes the draft instead of storing blank text", () => {
    vi.useFakeTimers();
    saveComposeDraftDebounced("apply", "lead-1", "typed something");
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    saveComposeDraftDebounced("apply", "lead-1", "   ");
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("apply", "lead-1")).toBe("");
    vi.useRealTimers();
  });
});
