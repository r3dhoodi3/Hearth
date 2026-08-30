// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// The real module is a "use server" file that pulls in the service-role
// Supabase client; the component only ever hands it to a <form action>.
vi.mock("./actions", () => ({
  sendContactMessageAction: vi.fn(),
}));

import ContactForm from "./ContactForm";

afterEach(() => cleanup());

function field(container: HTMLElement, name: string): HTMLInputElement {
  return container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
}

describe("ContactForm prefill", () => {
  // D3: a signed-in member who follows a legal-page link here should not
  // retype what the account already knows. /contact is public, so the page
  // passes empty strings when nobody is signed in.
  it("fills name, email and phone from the signed-in account", () => {
    const { container } = render(
      <ContactForm
        topic={null}
        name="Alex Rivera"
        email="alex@example.com"
        phone="7145550100"
      />
    );
    expect(field(container, "name")).toHaveValue("Alex Rivera");
    expect(field(container, "email")).toHaveValue("alex@example.com");
    expect(field(container, "phone")).toHaveValue("7145550100");
  });

  it("keeps every prefilled field editable", () => {
    const { container } = render(
      <ContactForm topic={null} name="Alex Rivera" email="alex@example.com" />
    );
    const email = field(container, "email");
    // defaultValue, never a controlled value: the account email is often not
    // the one somebody wants a reply at.
    fireEvent.change(email, { target: { value: "someone.else@example.com" } });
    expect(email).toHaveValue("someone.else@example.com");
  });

  it("renders empty fields for a signed-out visitor", () => {
    const { container } = render(<ContactForm topic={null} />);
    expect(field(container, "name")).toHaveValue("");
    expect(field(container, "email")).toHaveValue("");
    expect(field(container, "phone")).toHaveValue("");
  });

  it("leaves the honeypot alone", () => {
    const { container } = render(
      <ContactForm topic={null} name="Alex Rivera" email="alex@example.com" />
    );
    // A bot that fills every input fills this one; a prefill must never put a
    // value in it.
    expect(field(container, "company_website")).toHaveValue("");
  });
});
