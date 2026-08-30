// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Confirmation page sendContactMessageAction redirects to on a successful
// send (src/app/contact/actions.ts). Plain server component, no session read,
// so it renders directly with no mocks.

afterEach(() => cleanup());

import ContactThanksPage, { metadata } from "./page";

describe("ContactThanksPage", () => {
  it("says the message was sent and what happens next", () => {
    render(<ContactThanksPage />);
    expect(
      screen.getByRole("heading", { name: "Message sent" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/we read every message and will reach out/i)
    ).toBeInTheDocument();
  });

  it("has one primary CTA back to Hearth and a secondary link to the guides", () => {
    render(<ContactThanksPage />);
    const primary = screen.getByRole("link", { name: "Back to Hearth" });
    expect(primary).toHaveAttribute("href", "/");
    const secondary = screen.getByRole("link", { name: "Browse the guides" });
    expect(secondary).toHaveAttribute("href", "/guides");
  });

  it("is marked noindex so it never shows up as a search result", () => {
    expect(metadata.robots).toMatchObject({ index: false });
  });
});
