// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import OnboardingValueBullets from "./OnboardingValueBullets";

// Single source for the three bullets shown on both the sign-up screen and
// onboarding's address step (CR2#2). One test here pins the exact wording;
// both call sites just render this component, so they cannot drift.
describe("OnboardingValueBullets", () => {
  it("renders the three value bullets", () => {
    render(<OnboardingValueBullets />);
    expect(
      screen.getByText("Track every system and know what needs attention")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Proactive freeze, heat, and recall alerts for YOUR home"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("Scan a warranty or receipt and Hearth files it for you")
    ).toBeInTheDocument();
  });
});
