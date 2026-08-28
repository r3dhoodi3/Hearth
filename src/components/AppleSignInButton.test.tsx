// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Constructs the real browser Supabase client at render time (inside
// AppleSignInButtonBody), which throws without live project env vars. Only
// the constructor is ever reached in these tests (no click is fired), so a
// bare stub is enough - same pattern as ProjectsCard.test.tsx.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({}),
}));

const onError = vi.fn();

afterEach(() => {
  cleanup();
  onError.mockClear();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Both APPLE_SIGN_IN_ENABLED (src/lib/constants.ts, the owner's 2026-08-28
// "hide it for now" switch) and the button's own APPLE_SIGNIN_ENABLED (the
// "is the Supabase provider actually configured" switch) are read from
// process.env at module load time, so each case needs a fresh module
// instance via vi.resetModules() + a dynamic import after stubbing env vars.
describe("AppleSignInButton", () => {
  it("does not render by default (both env vars unset)", async () => {
    const { default: AppleSignInButton } = await import("./AppleSignInButton");
    render(<AppleSignInButton next={null} onError={onError} />);
    expect(
      screen.queryByRole("button", { name: /apple/i })
    ).not.toBeInTheDocument();
  });

  it("stays hidden when the provider is configured but the owner's switch is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGNIN", "1");
    const { default: AppleSignInButton } = await import("./AppleSignInButton");
    render(<AppleSignInButton next={null} onError={onError} />);
    expect(
      screen.queryByRole("button", { name: /apple/i })
    ).not.toBeInTheDocument();
  });

  it("stays hidden when the owner's switch is on but the provider isn't configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN", "on");
    const { default: AppleSignInButton } = await import("./AppleSignInButton");
    render(<AppleSignInButton next={null} onError={onError} />);
    expect(
      screen.queryByRole("button", { name: /apple/i })
    ).not.toBeInTheDocument();
  });

  it("renders once both the provider and the owner's switch are on", async () => {
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGNIN", "1");
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN", "on");
    const { default: AppleSignInButton } = await import("./AppleSignInButton");
    render(<AppleSignInButton next={null} onError={onError} />);
    expect(
      screen.getByRole("button", { name: /continue with apple/i })
    ).toBeInTheDocument();
  });
});
