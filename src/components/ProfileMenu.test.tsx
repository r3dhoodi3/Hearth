// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import ProfileMenu from "./ProfileMenu";

afterEach(() => {
  cleanup();
});

// Deferred: resolves only when the test calls `resolve()`, so a click can be
// asserted mid-flight (the actual bug this covers - the row used to sit
// there, still clickable, for the 1-2s a real setPreferredSideAction takes).
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ProfileMenu side switch", () => {
  it("shows a disabled 'Switching...' row and hides the rest of the menu the instant the switch is tapped", async () => {
    const { promise, resolve } = deferred();
    const action = vi.fn(() => promise);

    render(
      <ProfileMenu
        name="Jamie"
        links={[
          { href: "/account", label: "Edit profile" },
          {
            href: "/pro",
            label: "Switch to your business",
            action,
            side: "contractor",
          },
        ]}
      />
    );

    fireEvent.click(screen.getByLabelText("Account menu for Jamie"));
    const switchButton = screen.getByRole("button", {
      name: "Switch to your business",
    });
    // The "Edit profile" row's own wrapper (two levels up: the row itself,
    // then the panel section that collapses on switch) - checked by class
    // rather than toBeVisible(), since jsdom never loads the real Tailwind
    // stylesheet and so has no way to know the "hidden" utility class means
    // display: none.
    const collapsibleSection = () =>
      screen.getByText("Edit profile").parentElement?.parentElement;
    expect(collapsibleSection()).not.toHaveClass("hidden");

    await act(async () => {
      fireEvent.click(switchButton);
      // Let the pending state (and the effect that reports it up) commit.
      await Promise.resolve();
    });

    // The row itself: disabled, relabeled, mid-flight.
    expect(screen.getByRole("button", { name: /Switching to your business/ })).toBeDisabled();
    // Everything else in the panel is hidden, not gone - a second tap on a
    // stale row (the actual complaint) has nothing left to land on.
    expect(collapsibleSection()).toHaveClass("hidden");

    // A second click on the (now-disabled) row must not call the action again.
    fireEvent.click(screen.getByRole("button", { name: /Switching to your business/ }));
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
      await promise;
    });
  });

  it("renders side-switch rows as plain, non-pending buttons when idle", () => {
    render(
      <ProfileMenu
        name="Jamie"
        links={[
          {
            href: "/pro",
            label: "Switch to your business",
            action: vi.fn(),
            side: "contractor",
          },
        ]}
      />
    );
    fireEvent.click(screen.getByLabelText("Account menu for Jamie"));
    const button = screen.getByRole("button", { name: "Switch to your business" });
    expect(button).not.toBeDisabled();
  });

  // The avatar trigger is padded for a mouse (py-1). The phone-only min
  // height is what holds it at the 44px thumb minimum; jsdom applies no CSS,
  // so the class is the thing to assert. max-sm: leaves desktop as it was.
  it("keeps the account menu trigger at 44px on a phone", () => {
    render(<ProfileMenu name="Jamie" links={[]} />);
    expect(screen.getByLabelText("Account menu for Jamie").className).toContain(
      "max-sm:min-h-11"
    );
  });
});
