// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import AiNotice from "./AiNotice";

afterEach(() => {
  cleanup();
});

function notice(): HTMLElement {
  return screen.getByText(/AI-generated, and it can be wrong/).closest("p")!;
}

describe("AiNotice sizes", () => {
  it("bumps the 11px variant to 14px on phones and leaves desktop at 11px", () => {
    // The live check found this line rendering at 11px grey under the Ask
    // Hearth composer, on one of the two screens the phone push is built
    // around. jsdom applies no media queries, so the class is what gets
    // asserted: max-sm: means phones only, desktop unchanged.
    render(<AiNotice size="xxs" />);
    const el = notice();
    expect(el).toHaveClass("text-[11px]");
    expect(el).toHaveClass("max-sm:text-sm");
  });

  it("leaves the default 12px variant alone at every width", () => {
    render(<AiNotice />);
    const el = notice();
    expect(el).toHaveClass("text-xs");
    expect(el.className).not.toContain("max-sm:");
  });

  it("keeps the disclosure link attached to the label", () => {
    render(<AiNotice detail="Check the numbers." />);
    expect(screen.getByRole("link", { name: "How Hearth uses AI" })).toHaveAttribute(
      "href",
      "/ai-disclosure"
    );
    expect(notice()).toHaveTextContent("Check the numbers.");
  });
});
