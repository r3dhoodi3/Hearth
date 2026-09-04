// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component drives supabase.auth directly (verifyOtp / resend), so unlike
// the signup-page render test these stubs have to be real spies we can assert
// on and steer per test.
const verifyOtp = vi.fn();
const resend = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { verifyOtp, resend } }),
}));

// A "use server" action; stubbed so importing the component doesn't drag in the
// `server-only` admin chain under plain Vite (same reason as the page test).
const recordTermsAcceptance = vi.fn();
vi.mock("@/app/(auth)/recordTermsAcceptance", () => ({
  recordTermsAcceptance: (...args: unknown[]) => recordTermsAcceptance(...args),
}));

import EmailCodeVerify from "./EmailCodeVerify";

const EMAIL = "you@example.com";

// The success path does a full navigation via window.location.href. Replace
// location with a plain writable stub so the assignment doesn't try to navigate
// jsdom (which throws "Not implemented").
let originalLocation: Location;
beforeEach(() => {
  verifyOtp.mockReset();
  resend.mockReset();
  recordTermsAcceptance.mockReset();
  originalLocation = window.location;
  delete (window as { location?: unknown }).location;
  // @ts-expect-error - minimal stub, only .href is exercised
  window.location = { href: "" };
});

afterEach(() => {
  cleanup();
  // @ts-expect-error - restore the real location
  window.location = originalLocation;
});

function renderVerify() {
  return render(
    <EmailCodeVerify
      email={EMAIL}
      successHref="/onboarding"
      signInHref="/signin"
    />
  );
}

describe("EmailCodeVerify", () => {
  it("renders the code input and the email address", () => {
    renderVerify();
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
  });

  it("verifies a typed 6-digit code with verifyOtp", async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: "11111111-1111-1111-1111-111111111111" } },
      error: null,
    });
    renderVerify();

    const input = screen.getByLabelText("6-digit code");
    // Type a 5-digit code first so the auto-submit effect doesn't fire, then
    // click Verify explicitly to exercise the button path.
    await act(async () => {
      fireEvent.change(input, { target: { value: "12345" } });
    });
    const button = screen.getByRole("button", { name: "Verify" });
    expect(button).toBeDisabled();

    await act(async () => {
      fireEvent.change(input, { target: { value: "123456" } });
    });
    // Auto-submit already fired at 6 digits; verify the call shape.
    expect(verifyOtp).toHaveBeenCalledWith({
      email: EMAIL,
      token: "123456",
      type: "signup",
    });
  });

  it("records pro_terms when the verified user's stamped role is contractor", async () => {
    verifyOtp.mockResolvedValue({
      data: {
        user: {
          id: "22222222-2222-2222-2222-222222222222",
          user_metadata: { role: "contractor" },
        },
      },
      error: null,
    });
    renderVerify();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("6-digit code"), {
        target: { value: "654321" },
      });
    });

    expect(recordTermsAcceptance).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222",
      "pro_terms"
    );
  });

  it("records terms when the verified user has no contractor role stamped", async () => {
    verifyOtp.mockResolvedValue({
      data: {
        user: {
          id: "33333333-3333-3333-3333-333333333333",
          user_metadata: { role: "homeowner" },
        },
      },
      error: null,
    });
    renderVerify();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("6-digit code"), {
        target: { value: "111222" },
      });
    });

    expect(recordTermsAcceptance).toHaveBeenCalledWith(
      "33333333-3333-3333-3333-333333333333",
      "terms"
    );
  });

  it("shows the friendly error when verifyOtp rejects the code", async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null },
      error: { message: "Token has expired or is invalid" },
    });
    renderVerify();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("6-digit code"), {
        target: { value: "000000" },
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code didn't work"
    );
  });

  it("resends the code with supabase.auth.resend", async () => {
    resend.mockResolvedValue({ error: null });
    renderVerify();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    });

    expect(resend).toHaveBeenCalledWith({ type: "signup", email: EMAIL });
    expect(await screen.findByText("New code sent. Give it a minute or two.")).toBeInTheDocument();
  });
});
