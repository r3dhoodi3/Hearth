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

// The three onboarding value bullets were removed from the sign-up screen
// (owner request): they cluttered the account door, and onboarding still shows
// them where they're acted on. This guards that they stay off this page and the
// subtitle remains the one bit of value copy here.
describe("homeowner sign-up value bullets", () => {
  it("no longer shows the onboarding value bullets, keeps the subtitle", async () => {
    // The page reads searchParams via React's use(), which suspends for a
    // tick even against an already-resolved promise - the render has to be
    // awaited or React warns about an un-awaited act().
    await act(async () => {
      render(<HomeownerSignUpPage searchParams={Promise.resolve({})} />);
    });
    expect(
      screen.queryByText("Track every system and know what needs attention")
    ).toBeNull();
    expect(
      screen.queryByText(
        "Proactive freeze, heat, and recall alerts for YOUR home"
      )
    ).toBeNull();
    expect(
      screen.queryByText("Scan a warranty or receipt and Hearth files it for you")
    ).toBeNull();
    // The subtitle stays as the one line of value copy on the account door.
    expect(
      screen.getByText("Start tracking your home with Hearth.")
    ).toBeInTheDocument();
  });
});
