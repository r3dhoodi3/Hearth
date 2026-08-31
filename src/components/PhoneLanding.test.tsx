// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

import PhoneLanding from "./PhoneLanding";

// Vitest globals are off in this repo (see vitest.config.ts), so
// testing-library's auto-cleanup never wires itself up on its own.
afterEach(() => cleanup());

// The phone landing exists so a visitor who already installed the app can get
// into an account without reading a marketing page. Two properties keep that
// true and both are one careless edit away from regressing:
//
//  1. It is PHONE ONLY. The wrapper's `sm:hidden` is the other half of the
//     `max-sm:hidden` marks in src/app/page.tsx - exactly one landing renders
//     at any width, and desktop must be untouched. Drop this class and the
//     desktop page grows a duplicate hero.
//  2. The two role doors point at the real forms. "I'm a homeowner" goes
//     STRAIGHT to /homeowner-signup and "I'm a contractor" to
//     /contractor-signup, not to the /get-started "who are you?" fork:
//     this screen IS that fork, and routing through it again would cost an
//     extra tap for no answer.
//
// jsdom does not evaluate media queries, so these assert the classes rather
// than visibility - the rendered result is a viewport concern beyond a unit
// test's reach.
describe("PhoneLanding", () => {
  it("renders only below sm", () => {
    const { container } = render(<PhoneLanding />);
    expect(container.firstElementChild).toHaveClass("sm:hidden");
  });

  it("offers two equal role doors, straight to the real signup forms", () => {
    render(<PhoneLanding />);

    const homeowner = screen.getByRole("link", { name: "I'm a homeowner" });
    expect(homeowner).toHaveAttribute("href", "/homeowner-signup");
    expect(homeowner).toHaveClass("btn-primary", "min-h-12", "w-full");

    const contractor = screen.getByRole("link", { name: "I'm a contractor" });
    expect(contractor).toHaveAttribute("href", "/contractor-signup");
    expect(contractor).toHaveClass("btn-secondary", "min-h-12", "w-full");
  });

  it("keeps sign-in below the doors as a quieter full-width link, not a third button", () => {
    render(<PhoneLanding />);
    const signIn = screen.getByRole("link", {
      name: /already have an account\? sign in/i,
    });
    expect(signIn).toHaveAttribute("href", "/signin");
    expect(signIn.className).not.toMatch(/btn/);
    // Still a full 44px-tall, full-width tap target even though it reads quiet.
    expect(signIn).toHaveClass("min-h-11", "w-full");
  });

  it("keeps only Emergency help in the quiet row, since contractor is a door now", () => {
    render(<PhoneLanding />);
    const emergency = screen.getByRole("link", { name: "Emergency help" });
    expect(emergency).toHaveAttribute("href", "/emergency-help");
    expect(emergency.className).not.toMatch(/btn/);
    expect(emergency).toHaveClass("min-h-11");
    // The contractor link must not appear twice: its only home is the door.
    expect(
      screen.getAllByRole("link", { name: "I'm a contractor" })
    ).toHaveLength(1);
    // The old /pros quiet link is gone entirely.
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/pros");
  });

  it("shows the three one-line benefits so the screen is not just buttons", () => {
    render(<PhoneLanding />);
    for (const line of [
      "Freeze and heat warnings before things break.",
      "Maintenance reminders for what your home has.",
      "Local pros, fee shown before you post a job.",
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
  });

  it("does not repeat Privacy here (it lives in the phone footer only)", () => {
    render(<PhoneLanding />);
    expect(screen.queryByRole("link", { name: "Privacy" })).toBeNull();
  });

  it("keeps the theme switch reachable, since the page header is hidden on phone", () => {
    render(<PhoneLanding />);
    expect(
      screen.getByRole("button", { name: /switch to (light|dark) mode/i })
    ).toBeInTheDocument();
  });

  it("says one thing above the doors and smuggles no marketing sections back in", () => {
    render(<PhoneLanding />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Your home, looked after." })
    ).toBeInTheDocument();
    expect(screen.queryByText(/How it works/i)).toBeNull();
    expect(screen.queryByText(/What Hearth watches for you/i)).toBeNull();
  });
});
