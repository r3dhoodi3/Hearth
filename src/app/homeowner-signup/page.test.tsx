// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The page only touches supabase.auth from inside its submit/resend
// handlers, neither of which this render test fires, so a bare stub is
// enough to satisfy the top-level createClient() call.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: {} }),
}));

// A "use server" action, only ever called from onSubmit (not fired by this
// render test), but it pulls in src/lib/supabase/admin.ts's `server-only`
// import at module load time - real in a Next build, unresolvable under
// plain Vite. Stubbed so importing the page doesn't drag that chain in.
vi.mock("@/app/(auth)/recordTermsAcceptance", () => ({
  recordTermsAcceptance: vi.fn(),
}));

import HomeownerSignUpPage from "./page";

afterEach(() => cleanup());

// CR2#2: the three value bullets used to live one screen later, on
// onboarding's address step, leaving the sign-up screen with nothing but
// "Start tracking your home with Hearth." They now render here too, from the
// same shared component onboarding uses (src/components/OnboardingValueBullets.tsx),
// so the two can never say something different.
describe("homeowner sign-up value bullets", () => {
  it("shows the same three bullets onboarding shows, above the form", async () => {
    // The page reads searchParams via React's use(), which suspends for a
    // tick even against an already-resolved promise - the render has to be
    // awaited or React warns about an un-awaited act().
    await act(async () => {
      render(<HomeownerSignUpPage searchParams={Promise.resolve({})} />);
    });
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
    // Still there, unchanged.
    expect(
      screen.getByText("Start tracking your home with Hearth.")
    ).toBeInTheDocument();
  });
});
