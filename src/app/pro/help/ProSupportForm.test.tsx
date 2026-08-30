// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The real module is a "use server" file; the component only ever hands it
// to a <form action>.
vi.mock("./actions", () => ({ sendProSupportMessageAction: vi.fn() }));

import ProSupportForm from "./ProSupportForm";

afterEach(() => cleanup());

describe("ProSupportForm sent state", () => {
  // sendProSupportMessageAction (./actions.ts) redirects to
  // /pro/help?sent=1 on a successful send; page.tsx passes that as the
  // `sent` prop. This pins the swap: the plain form disappears in favor of a
  // confirmation card, not just a toast a pro can miss between leads.
  it("shows the message form when not sent", () => {
    const { container } = render(
      <ProSupportForm member={false} name="Sam" email="sam@example.com" phone="" />
    );
    expect(container.querySelector('textarea[name="message"]')).toBeInTheDocument();
    expect(screen.queryByText("Message sent")).not.toBeInTheDocument();
  });

  it("replaces the form with a confirmation card once sent", () => {
    const { container } = render(
      <ProSupportForm member={false} name="Sam" email="sam@example.com" phone="" sent />
    );
    expect(screen.getByText("Message sent")).toBeInTheDocument();
    expect(container.querySelector('textarea[name="message"]')).not.toBeInTheDocument();
  });

  it("gives the confirmation card one primary CTA to find jobs and a secondary to send another", () => {
    render(
      <ProSupportForm member={false} name="Sam" email="sam@example.com" phone="" sent />
    );
    const primary = screen.getByRole("link", { name: "Find jobs" });
    expect(primary).toHaveAttribute("href", "/pro");
    const secondary = screen.getByRole("link", { name: "Send another" });
    expect(secondary).toHaveAttribute("href", "/pro/help");
  });
});

describe("ProSupportForm honeypot", () => {
  // Mirrors the homeowner help form and the public contact form: one hidden
  // field name across every form that writes to support_messages.
  it("renders an empty, untabbable company_website field", () => {
    const { container } = render(
      <ProSupportForm member name="Sam" email="sam@example.com" phone="555" />
    );
    const pot = container.querySelector<HTMLInputElement>(
      'input[name="company_website"]'
    );
    expect(pot).toBeInTheDocument();
    expect(pot).toHaveValue("");
    expect(pot).toHaveAttribute("tabindex", "-1");
  });
});
