// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The real module is a "use server" file; the component only ever hands it
// to a <form action>.
vi.mock("./actions", () => ({ submitFeedbackAction: vi.fn() }));

import FeedbackForm from "./FeedbackForm";

afterEach(() => cleanup());

describe("homeowner bug-report page", () => {
  it("presents itself as the bug-report page and welcomes non-bugs too", () => {
    render(<FeedbackForm defaultEmail="alex@example.com" />);
    expect(
      screen.getByRole("heading", { name: "Report a bug" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ideas and complaints count too/)
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("What happened, or what could be better?")
    ).toBeInTheDocument();
  });

  it("promises no money: homeowners have no wallet to credit", () => {
    // The $5 first-report credit is a pro-side thing (src/lib/proFeedback.ts).
    // Offering homeowners cash or credit here would be a lie the page cannot
    // keep, so no dollar sign and no credit talk may render.
    const { container } = render(<FeedbackForm defaultEmail="" />);
    expect(container.textContent).not.toContain("$");
    expect(container.textContent!.toLowerCase()).not.toContain("credit");
  });

  it("only asks for an email once the person opts into a reply", () => {
    const { container } = render(
      <FeedbackForm defaultEmail="alex@example.com" />
    );
    expect(
      container.querySelector('input[name="contact_email"]')
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    const email = container.querySelector<HTMLInputElement>(
      'input[name="contact_email"]'
    );
    expect(email).toBeInTheDocument();
    expect(email).toHaveValue("alex@example.com");
  });
});
