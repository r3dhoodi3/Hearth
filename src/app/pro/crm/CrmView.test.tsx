// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CrmView, { type SuggestionVM } from "./CrmView";
import { DRAFT_SAVE_DEBOUNCE_MS, readComposeDraft } from "@/lib/proComposeDraft";

// CrmView imports "./actions" ("use server"), which pulls in the service-role
// Supabase client and throws outside a real server render - see the long
// comment atop reviewAskMessage.ts and src/app/pro/crm/page.test.ts. Mocking
// the module (same pattern as ProToolsClient.test.tsx) is what makes a real
// render possible here.
vi.mock("./actions", () => ({
  addClientAction: vi.fn(),
  trackLeadAction: vi.fn(),
}));

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());

const STAGE_OPTIONS = [
  { value: "lead", label: "Lead" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

function baseProps(overrides: Partial<React.ComponentProps<typeof CrmView>> = {}) {
  return {
    q: "",
    stageTiles: [],
    stageOptions: STAGE_OPTIONS,
    addedClientCount: 0,
    todayStr: "2026-08-30",
    dueForFollowUp: [],
    suggestions: [],
    displayCount: 0,
    groups: [],
    member: false,
    hasProSubscriptionRow: false,
    ...overrides,
  };
}

const SUGGESTION: SuggestionVM = {
  id: "lead-1",
  name: "Sarah",
  metaLine: "Plumbing · Aug 28, 2026",
  stage: "lead",
};

describe("CrmView: suggestions above the manual form (CR5#7)", () => {
  it("renders the manual form directly when there are no suggestions", () => {
    render(<CrmView {...baseProps()} />);
    expect(screen.getByLabelText("Client name")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add someone else/i })).toBeNull();
  });

  it("collapses the manual form behind a button when a suggestion exists, above the form", () => {
    render(<CrmView {...baseProps({ suggestions: [SUGGESTION] })} />);
    expect(screen.queryByLabelText("Client name")).toBeNull();
    const button = screen.getByRole("button", { name: /add someone else/i });
    expect(button).toBeInTheDocument();

    // "Track from your jobs" appears before "Add a client" in source order.
    const html = document.body.innerHTML;
    expect(html.indexOf("Track from your jobs")).toBeLessThan(
      html.indexOf("Add a client")
    );

    fireEvent.click(button);
    expect(screen.getByLabelText("Client name")).toBeInTheDocument();
  });

  it("links each suggestion to the tools page with its lead id (CR5#1)", () => {
    render(<CrmView {...baseProps({ suggestions: [SUGGESTION] })} />);
    const link = screen.getByRole("link", { name: "Estimate" });
    expect(link).toHaveAttribute("href", "/pro/tools?lead=lead-1");
  });
});

describe("CrmView: add-a-client note autosave (CR5#4)", () => {
  it("saves the note debounced and restores it after remount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<CrmView {...baseProps()} />);
    const note = screen.getByLabelText("Note (optional)");
    fireEvent.change(note, { target: { value: "Wants a quote by Friday" } });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("crm_note", "add-client")).toBe(
      "Wants a quote by Friday"
    );
    unmount();

    render(<CrmView {...baseProps()} />);
    expect(screen.getByLabelText("Note (optional)")).toHaveValue(
      "Wants a quote by Friday"
    );
    vi.useRealTimers();
  });

  it("restores the note once the form is opened from behind the button", () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "hearth.pro-draft.v1.crm_note.add-client",
      "Half-typed note"
    );
    render(<CrmView {...baseProps({ suggestions: [SUGGESTION] })} />);
    fireEvent.click(screen.getByRole("button", { name: /add someone else/i }));
    expect(screen.getByLabelText("Note (optional)")).toHaveValue(
      "Half-typed note"
    );
    vi.useRealTimers();
  });

  it("clears the draft once a client is actually added (addedClientCount rises)", () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "hearth.pro-draft.v1.crm_note.add-client",
      "Old draft"
    );
    const { rerender } = render(<CrmView {...baseProps({ addedClientCount: 0 })} />);
    rerender(<CrmView {...baseProps({ addedClientCount: 1 })} />);
    expect(readComposeDraft("crm_note", "add-client")).toBe("");
    vi.useRealTimers();
  });
});
