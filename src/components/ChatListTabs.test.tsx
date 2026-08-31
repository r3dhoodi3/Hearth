// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import ChatListTabs from "./ChatListTabs";

// The switcher itself, exercised the way the homeowner page uses it
// (src/app/(app)/chats/page.tsx hands it server-rendered rows; the pro side's
// ChatsView.test.tsx covers the same behavior through ChatsView). The rows
// here stand in for renderConvoRow's output: what matters is that whatever is
// handed as activeRows only shows on Active, closedRows only on Closed, and
// the pinned row never leaves.

afterEach(() => {
  cleanup();
});

function renderTabs(
  extra: Partial<Parameters<typeof ChatListTabs>[0]> = {}
) {
  return render(
    <ChatListTabs
      hiddenOnMobile={false}
      activeCount={1}
      closedCount={1}
      activeEmpty="No open conversations yet. Pick a pro for a job and your chat starts here."
      closedEmpty="Nothing here yet. Finished conversations land here."
      pinned={<li>Ask Hearth</li>}
      activeRows={<li>Plumber Pete</li>}
      closedRows={<li>Roofer Rita</li>}
      {...extra}
    />
  );
}

describe("ChatListTabs", () => {
  it("defaults to Active: active rows show, closed rows do not", () => {
    renderTabs();
    expect(screen.getByText("Plumber Pete")).toBeInTheDocument();
    expect(screen.queryByText("Roofer Rita")).toBeNull();
    expect(screen.getByRole("button", { name: /Active/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows the closed rows under Closed, and only there", () => {
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(screen.getByText("Roofer Rita")).toBeInTheDocument();
    expect(screen.queryByText("Plumber Pete")).toBeNull();
  });

  it("keeps the pinned Ask Hearth row on both tabs, untouched by the filter", () => {
    renderTabs();
    expect(screen.getByText("Ask Hearth")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(screen.getByText("Ask Hearth")).toBeInTheDocument();
  });

  it("shows counts off the fetched list and hides a zero", () => {
    renderTabs({ activeCount: 2, closedCount: 0 });
    expect(screen.getByRole("button", { name: "Active (2)" })).toBeInTheDocument();
    // A zero would just be noise next to the empty state.
    expect(screen.getByRole("button", { name: "Closed" })).toBeInTheDocument();
  });

  it("shows each tab's empty sentence when it has no conversations", () => {
    renderTabs({
      activeCount: 0,
      closedCount: 0,
      activeRows: null,
      closedRows: null,
    });
    expect(
      screen.getByText(
        "No open conversations yet. Pick a pro for a job and your chat starts here."
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(
      screen.getByText("Nothing here yet. Finished conversations land here.")
    ).toBeInTheDocument();
  });

  it("can start on Closed for a deep link into a finished thread", () => {
    renderTabs({ initialTab: "closed" });
    expect(screen.getByText("Roofer Rita")).toBeInTheDocument();
    expect(screen.queryByText("Plumber Pete")).toBeNull();
  });

  it("keeps 44px tap targets on the phone-width buttons", () => {
    renderTabs();
    // min-h-11 (44px) below sm, collapsing at sm like AccountTabs does.
    expect(screen.getByRole("button", { name: /Active/ }).className).toContain(
      "min-h-11"
    );
    expect(screen.getByRole("button", { name: /Active/ }).className).toContain(
      "sm:min-h-0"
    );
  });
});
