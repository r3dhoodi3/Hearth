// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// The real module is a "use server" file that pulls in the service-role
// Supabase client; the component only ever hands it to a <form action>.
vi.mock("./actions", () => ({
  sendContactMessageAction: vi.fn(),
}));

import ContactForm from "./ContactForm";
import { sendContactMessageAction } from "./actions";

const action = vi.mocked(sendContactMessageAction);

afterEach(() => {
  cleanup();
  action.mockReset();
});

function field(container: HTMLElement, name: string): HTMLInputElement {
  return container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
}

function messageBox(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector(
    'textarea[name="message"]'
  ) as HTMLTextAreaElement;
}

function submit(container: HTMLElement) {
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
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
    // Controlled, but seeded from the prop rather than pinned to it: the
    // account email is often not the one somebody wants a reply at.
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

// React 19 resets a form once the function given to <form action> settles, on
// the error return exactly as much as on success. Uncontrolled fields meant a
// refused message took the visitor's own words with it (verified live and
// locally, 2026-08-30); controlled fields make that reset a no-op.
describe("ContactForm failure handling", () => {
  it("keeps what was typed when the action returns a validation error", async () => {
    action.mockResolvedValue({
      ok: false,
      error: "Please add an email or a phone number so we can reply.",
    });
    const { container, findByRole } = render(<ContactForm topic={null} />);

    fireEvent.change(field(container, "name"), {
      target: { value: "Alex Rivera" },
    });
    fireEvent.change(messageBox(container), {
      target: { value: "The upstairs bathroom fan has stopped working." },
    });
    submit(container);

    const alert = await findByRole("alert");
    expect(alert).toHaveTextContent(
      "Please add an email or a phone number so we can reply."
    );
    expect(field(container, "name")).toHaveValue("Alex Rivera");
    expect(messageBox(container)).toHaveValue(
      "The upstairs bathroom fan has stopped working."
    );
  });

  it("shows a retry message instead of blowing up the page when the request fails", async () => {
    // What a 500 from the action endpoint or a dropped connection looks like
    // on the client: the server reference's promise rejects. Before the catch
    // this reached the nearest error boundary and replaced the whole page.
    action.mockRejectedValue(new Error("Failed to fetch"));
    const { container, findByRole } = render(<ContactForm topic={null} />);

    fireEvent.change(messageBox(container), {
      target: { value: "Please call me back about my account." },
    });
    submit(container);

    const alert = await findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Please try again.");
    expect(messageBox(container)).toHaveValue(
      "Please call me back about my account."
    );
  });

  it("lets the success redirect through instead of reporting it as a failure", async () => {
    // redirect() inside the action surfaces here as a throw carrying a
    // NEXT_REDIRECT digest. Catching it would tell somebody their message
    // failed at the exact moment it was stored.
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/contact/thanks;303;",
    });
    action.mockRejectedValue(redirectError);
    const onError = vi.fn();
    window.addEventListener("error", onError);

    const { container, queryByRole } = render(<ContactForm topic={null} />);
    fireEvent.change(messageBox(container), {
      target: { value: "Thanks for building this, one question though." },
    });
    submit(container);

    await waitFor(() => expect(action).toHaveBeenCalled());
    // No inline failure message: the throw was handed back to the router.
    await waitFor(() => expect(queryByRole("alert")).toBeNull());
    window.removeEventListener("error", onError);
  });
});
