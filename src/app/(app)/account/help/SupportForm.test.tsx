// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The real module is a "use server" file; the component only ever hands it
// to a <form action>.
import { vi } from "vitest";
vi.mock("./actions", () => ({ saveSupportMessageAction: vi.fn() }));

import SupportForm from "./SupportForm";

afterEach(() => cleanup());

describe("SupportForm sent state", () => {
  // saveSupportMessageAction (./actions.ts) redirects to /account/help?sent=1
  // on a successful send; page.tsx passes that as the `sent` prop. This pins
  // the swap: the plain form disappears in favor of a confirmation card, not
  // just a toast that a homeowner can miss.
  it("shows the message form when not sent", () => {
    const { container } = render(
      <SupportForm name="Alex" email="alex@example.com" phone="" />
    );
    expect(container.querySelector('textarea[name="message"]')).toBeInTheDocument();
    expect(screen.queryByText("Message sent")).not.toBeInTheDocument();
  });

  it("replaces the form with a confirmation card once sent", () => {
    const { container } = render(
      <SupportForm name="Alex" email="alex@example.com" phone="" sent />
    );
    expect(screen.getByText("Message sent")).toBeInTheDocument();
    expect(container.querySelector('textarea[name="message"]')).not.toBeInTheDocument();
  });

  it("gives the confirmation card one primary CTA back to the dashboard and a secondary to send another", () => {
    render(
      <SupportForm name="Alex" email="alex@example.com" phone="" sent />
    );
    const primary = screen.getByRole("link", { name: "Back to my dashboard" });
    expect(primary).toHaveAttribute("href", "/dashboard");
    const secondary = screen.getByRole("link", { name: "Send another" });
    expect(secondary).toHaveAttribute("href", "/account/help");
  });
});
