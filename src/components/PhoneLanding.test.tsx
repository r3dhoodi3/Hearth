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
//  2. The two doors point at the real forms. "Create your account" goes
//     STRAIGHT to /homeowner-signup, not to the /get-started "who are you?"
//     fork: this screen already asks that question with its "I'm a
//     contractor" link, and the fork would cost an extra tap for no answer.
//
// jsdom does not evaluate media queries, so these assert the classes rather
// than visibility - the rendered result is a viewport concern beyond a unit
// test's reach.
describe("PhoneLanding", () => {
  it("renders only below sm", () => {
    const { container } = render(<PhoneLanding />);
    expect(container.firstElementChild).toHaveClass("sm:hidden");
  });

  it("offers exactly two big doors, straight to the real forms", () => {
    render(<PhoneLanding />);

    const create = screen.getByRole("link", { name: "Create your account" });
    expect(create).toHaveAttribute("href", "/homeowner-signup");
    expect(create).toHaveClass("btn-primary", "min-h-12", "w-full");

    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn).toHaveAttribute("href", "/signin");
    expect(signIn).toHaveClass("btn-secondary", "min-h-12", "w-full");
  });

  it("keeps the two quiet doors as small text links, not buttons, each clearing 44px", () => {
    render(<PhoneLanding />);
    const quiet = [
      ["I'm a contractor", "/pros"],
      ["Emergency help", "/emergency-help"],
    ] as const;
    for (const [name, href] of quiet) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link.className).not.toMatch(/btn/);
      expect(link).toHaveClass("min-h-11");
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

  it("says one thing above the two buttons and nothing else", () => {
    render(<PhoneLanding />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Your home, looked after." })
    ).toBeInTheDocument();
    // No marketing sections smuggled back in.
    expect(screen.queryByText(/How it works/i)).toBeNull();
    expect(screen.queryByText(/What Hearth watches for you/i)).toBeNull();
  });
});
