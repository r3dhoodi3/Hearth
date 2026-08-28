// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import ToolsMenu from "./ToolsMenu";

afterEach(() => {
  cleanup();
});

function openMenu(hasPlus = false) {
  render(<ToolsMenu hasPlus={hasPlus} />);
  const trigger = screen.getByRole("button", { name: /tools/i });
  fireEvent.click(trigger);
  return trigger;
}

describe("ToolsMenu phone sheet", () => {
  it("renders the same links, in the same order, as the desktop dropdown", () => {
    openMenu();

    // Both the desktop dropdown and the phone sheet are mounted at once
    // (toggled with sm:hidden / hidden sm:block, which jsdom doesn't apply),
    // so scope to the sheet's dialog to read only its copy of the links.
    const dialog = screen.getByRole("dialog", { name: "Tools" });
    const hrefs = within(dialog)
      .getAllByRole("link")
      .map((l) => l.getAttribute("href"));

    expect(hrefs).toEqual([
      "/emergency",
      "/walkthrough",
      "/home-details",
      "/documents",
      "/value",
      "/taxes",
      "/inspection",
      "/learn",
      "/forecast",
      "/quote-check",
      "/home-report",
    ]);
  });

  it("shows the Plus chip on member-gated tools for a non-Plus account", () => {
    openMenu(false);
    const dialog = screen.getByRole("dialog", { name: "Tools" });
    // One chip per plusTools entry (Cost forecast, Quote analyzer, Home report).
    expect(within(dialog).getAllByText("Plus")).toHaveLength(3);
  });

  it("hides the Plus chip for an account that already has Plus", () => {
    openMenu(true);
    const dialog = screen.getByRole("dialog", { name: "Tools" });
    expect(within(dialog).queryByText("Plus")).toBeNull();
  });

  it("is a labeled, modal dialog and moves focus into it on open", () => {
    openMenu();
    const dialog = screen.getByRole("dialog", { name: "Tools" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const trigger = openMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when the scrim is tapped", () => {
    const trigger = openMenu();
    const dialog = screen.getByRole("dialog", { name: "Tools" });
    // The scrim is the dialog's fixed-position sibling, rendered right before it.
    const scrim = dialog.previousElementSibling as HTMLElement;

    fireEvent.click(scrim);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when the X is tapped", () => {
    const trigger = openMenu();
    const dialog = screen.getByRole("dialog", { name: "Tools" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  // The trigger sits in the app header next to the address label, so its
  // padding is deliberately tight. The phone-only min height is what keeps it
  // at the 44px thumb minimum; jsdom applies no CSS, so the class itself is
  // the thing to assert. Desktop sizing is untouched (the bump is max-sm:).
  it("keeps the Tools trigger at 44px on a phone", () => {
    render(<ToolsMenu hasPlus={false} />);
    expect(screen.getByRole("button", { name: /tools/i }).className).toContain(
      "max-sm:min-h-11"
    );
  });
});
