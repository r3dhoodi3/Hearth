// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(screen.getByLabelText("The job, in your words")).toHaveValue(
      "Leaking pipe under the kitchen sink for Sarah"
    );
    expect(screen.getByLabelText("Your price")).toHaveValue("$450");
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
    expect(screen.getByLabelText("The job, in your words")).toHaveValue(
      "Replaced the water heater"
    );
  });

  it("renders blank fields with no initialLead, same as before", () => {
    render(<ProToolsClient initialPastJobs={[]} categories={[]} leads={[]} />);
    expect(screen.getByLabelText("The job, in your words")).toHaveValue("");
  });
});

describe("ProToolsClient: autosave", () => {
  it("saves the estimate description debounced and restores it after remount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <ProToolsClient initialPastJobs={[]} categories={[]} leads={[]} />
    );
    const field = screen.getByLabelText("The job, in your words");
    fireEvent.change(field, { target: { value: "New water heater, garage" } });
    vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS);
    expect(readComposeDraft("tool", "estimate")).toBe("New water heater, garage");
    unmount();

    render(<ProToolsClient initialPastJobs={[]} categories={[]} leads={[]} />);
    expect(screen.getByLabelText("The job, in your words")).toHaveValue(
      "New water heater, garage"
    );
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
    expect(screen.getByLabelText("The job, in your words")).toHaveValue(
      "Edited after the prefill loaded"
    );
    vi.useRealTimers();
  });
});

// C1 (2026-09-07 tester wave): "Job category" and "Your price" are mandatory
// on the estimate tab. The client checks them for the inline message; the
// SERVER is the gate, and it does more than check for emptiness: category has
// to be one of the app's own values (it is interpolated into the model prompt,
// so an allowlist is what stops a hand-rolled POST writing its own line
// there), and price has to contain a real, positive, bounded dollar amount.
describe("C1: the server gate on the estimate tool", () => {
  // jsdom's import.meta.url is not a file: URL, so these read from the vitest
  // root (the repo) rather than relative to this file.
  const route = readFileSync(
    join(process.cwd(), "src/app/api/pro-tools/route.ts"),
    "utf8"
  );

  it("rejects a category that is not in JOB_CATEGORIES", () => {
    expect(route).toContain(
      "if (!category || !JOB_CATEGORIES.some((c) => c.value === category))"
    );
    expect(route).toContain('{ error: "Pick a job category." }');
  });

  it("bounds the price above zero and below a sane ceiling", () => {
    expect(route).toContain("const MAX_ESTIMATE_PRICE = 1_000_000;");
    expect(route).toContain("priceValue <= 0");
    expect(route).toContain("priceValue > MAX_ESTIMATE_PRICE");
    expect(route).toContain('{ error: "Enter your price as a dollar amount." }');
  });

  it("keeps no invented example text in the client's placeholders", () => {
    const client = readFileSync(
      join(process.cwd(), "src/app/pro/tools/ProToolsClient.tsx"),
      "utf8"
    );
    for (const invented of [
      "40-gallon water heater",
      "$1,850 all-in",
      "Hendersons",
      "Rheem 50-gal",
      "About 2 weeks",
    ]) {
      expect(client, invented).not.toContain(invented);
    }
  });
});
