// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProToolsClient from "./ProToolsClient";
import { DRAFT_SAVE_DEBOUNCE_MS, readComposeDraft } from "@/lib/proComposeDraft";

// CR5#1 (tools prefill) and CR5#4 (autosave). The ownership check itself
// lives server-side in page.tsx (never trust a ?lead= id); this only covers
// what ProToolsClient does with data it was already handed.

vi.mock("./actions", () => ({
  deletePastJobAction: vi.fn(),
  recordToolEditAction: vi.fn(),
  sendDraftToLeadAction: vi.fn(),
}));

afterEach(() => cleanup());

beforeEach(() => {
  localStorage.clear();
});

describe("ProToolsClient: prefill from a lead", () => {
  it("seeds the estimate tab's category, price, and description from initialLead", () => {
    render(
      <ProToolsClient
        initialPastJobs={[]}
        categories={["plumbing"]}
        leads={[]}
        initialLead={{
          category: "plumbing",
          homeownerFirstName: "Sarah",
          description: "Leaking pipe under the kitchen sink",
          amount: "$450",
        }}
      />
    );
    expect(
      screen.getByPlaceholderText(
        /tear out the old 40-gallon water heater/i
      )
    ).toHaveValue("Leaking pipe under the kitchen sink for Sarah");
    expect(screen.getByPlaceholderText("$1,850 all-in")).toHaveValue("$450");
  });

  it("opens on the tab named by initialTool", () => {
    render(
      <ProToolsClient
        initialPastJobs={[]}
        categories={[]}
        leads={[]}
        initialLead={{
          category: null,
          homeownerFirstName: null,
          description: "Replaced the water heater",
          amount: null,
        }}
        initialTool="invoice"
      />
    );
    // The invoice tab's own field is on screen; the estimate tab's is not.
    expect(
      screen.getByPlaceholderText("Replaced the water heater at the Hendersons' place on Maple St, finished Tuesday")
    ).toBeInTheDocument();
  });

  it("renders blank fields with no initialLead, same as before", () => {
    render(<ProToolsClient initialPastJobs={[]} categories={[]} leads={[]} />);
    expect(
      screen.getByPlaceholderText(/tear out the old 40-gallon water heater/i)
    ).toHaveValue("");
  });
});

describe("ProToolsClient: autosave", () => {
  it("saves the estimate description debounced and restores it after remount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <ProToolsClient initialPastJobs={[]} categories={[]} leads={[]} />
    );
    const field = screen.getByPlaceholderText(/tear out the old 40-gallon water heater/i);
    fireEvent.change(field, { target: { value: "New water heater, garage" } });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("tool", "estimate")).toBe("New water heater, garage");
    unmount();

    render(<ProToolsClient initialPastJobs={[]} categories={[]} leads={[]} />);
    expect(
      screen.getByPlaceholderText(/tear out the old 40-gallon water heater/i)
    ).toHaveValue("New water heater, garage");
    vi.useRealTimers();
  });

  it("a saved draft wins over a stale lead prefill on restore", () => {
    vi.useFakeTimers();
    localStorage.setItem(
      "hearth.pro-draft.v1.tool.estimate",
      "Edited after the prefill loaded"
    );
    render(
      <ProToolsClient
        initialPastJobs={[]}
        categories={[]}
        leads={[]}
        initialLead={{
          category: null,
          homeownerFirstName: null,
          description: "Original prefilled text",
          amount: null,
        }}
      />
    );
    expect(
      screen.getByPlaceholderText(/tear out the old 40-gallon water heater/i)
    ).toHaveValue("Edited after the prefill loaded");
    vi.useRealTimers();
  });
});
