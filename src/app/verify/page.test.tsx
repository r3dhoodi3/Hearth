// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page renders EmailCodeVerify, which drives supabase.auth directly and
// imports the "use server" terms action. Stub both the same way the
// EmailCodeVerify test does so importing the page under plain Vite doesn't drag
// in the real client or the server-only admin chain.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { verifyOtp: vi.fn(), resend: vi.fn() } }),
}));
vi.mock("@/app/(auth)/recordTermsAcceptance", () => ({
  recordTermsAcceptance: vi.fn(),
}));

import VerifyPage from "./page";

// The page unwraps searchParams with React.use(), so it needs a Promise. An
// already-resolved one reads synchronously on the first render, but wrapping in
// Suspense keeps the render valid if React ever suspends on it.
async function renderVerify(searchParams: { email?: string }) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <VerifyPage searchParams={Promise.resolve(searchParams)} />
      </Suspense>
    );
  });
}

afterEach(() => cleanup());

// EmailCodeVerify's own success path assigns window.location.href; nothing in
// these tests reaches it, but stub location to keep the environment clean.
let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  delete (window as { location?: unknown }).location;
  // @ts-expect-error - minimal stub
  window.location = { href: "" };
});
afterEach(() => {
  // @ts-expect-error - restore the real location
  window.location = originalLocation;
});

describe("VerifyPage", () => {
  it("renders the code input when a valid ?email= is present", async () => {
    await renderVerify({ email: "you@example.com" });
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
    expect(screen.getByText("you@example.com")).toBeInTheDocument();
  });

  it("renders the email-entry form when no email is given", async () => {
    await renderVerify({});
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" })
    ).toBeInTheDocument();
    // The code panel should NOT be on screen yet.
    expect(screen.queryByLabelText("6-digit code")).not.toBeInTheDocument();
  });

  it("renders the email-entry form when ?email= is malformed", async () => {
    await renderVerify({ email: "not-an-email" });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("6-digit code")).not.toBeInTheDocument();
  });
});
