// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ActivityList, { type ActivityRow } from "./ActivityList";

afterEach(() => cleanup());

function row(id: string, label: string): ActivityRow {
  return { id, label, when: "Jan 1, 2026", amount: "10.00", positive: true };
}

// Owner's ask, 2026-08-30: on a phone, /pro/billing should not need scrolling
// to add credit, so Activity - the longest section on the page - shows only
// its latest 3 rows below sm, behind a "See all activity" button that
// expands the rest in place (no navigation, no lost scroll position).
// Desktop never had a limit and keeps none: every row is rendered at all
// times, and the button only turns visible below sm (max-sm:block on a
// hidden base), so it has no effect on the desktop layout either.
describe("ActivityList: phone row limit and expand", () => {
  it("renders all rows and no button when there are 3 or fewer", () => {
    const rows = [row("1", "Deposit"), row("2", "Lead unlocked")];
    render(<ActivityList rows={rows} />);
    expect(screen.getByText("Deposit")).toBeInTheDocument();
    expect(screen.getByText("Lead unlocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /see all activity/i })).toBeNull();
  });

  it("renders every row in the DOM even before expanding - desktop always sees all of them", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(String(n), `Row ${n}`));
    render(<ActivityList rows={rows} />);
    // All 5 <li> rows exist in the DOM; rows past the phone limit are only
    // max-sm:hidden (a CSS rule, invisible to jsdom's DOM query), never
    // omitted, so a real desktop viewport shows the full list unconditionally.
    for (const r of rows) {
      expect(screen.getByText(r.label)).toBeInTheDocument();
    }
  });

  it("shows a phone-only 'See all activity' button once there are more than 3 rows", () => {
    const rows = [1, 2, 3, 4].map((n) => row(String(n), `Row ${n}`));
    render(<ActivityList rows={rows} />);
    const button = screen.getByRole("button", { name: "See all activity" });
    expect(button).toHaveClass("hidden");
    expect(button).toHaveClass("max-sm:block");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking the button flips it to 'Show less' and marks it expanded, without navigating", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(String(n), `Row ${n}`));
    render(<ActivityList rows={rows} />);
    const button = screen.getByRole("button", { name: "See all activity" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    // Same rows, same component instance: expanding is client state, not a
    // route change.
    for (const r of rows) {
      expect(screen.getByText(r.label)).toBeInTheDocument();
    }
  });

  it("still renders the guarantee paragraph and empty state exactly as before", () => {
    render(<ActivityList rows={[]} />);
    expect(screen.getByText("No activity yet. Add credit to get started.")).toBeInTheDocument();
    expect(screen.queryByText(/Ghost protection:/)).toBeNull();
  });
});
