import { describe, expect, it } from "vitest";
import {
  isHomeownerShellPath,
  isProPath,
  isSignupConfirmationPath,
  landingFor,
  resolveAuthRole,
  ROLE_PICKER_PATH,
  type Sides,
} from "@/lib/roleRouting";

describe("isProPath", () => {
  it("matches the pro app and nothing that merely starts like it", () => {
    expect(isProPath("/pro")).toBe(true);
    expect(isProPath("/pro/onboarding")).toBe(true);
    expect(isProPath("/pro?tab=leads")).toBe(true);
    // Public pages that are NOT the contractor app.
    expect(isProPath("/pros")).toBe(false);
    expect(isProPath("/pro-terms")).toBe(false);
    expect(isProPath("/profile")).toBe(false);
  });
});

describe("isHomeownerShellPath", () => {
  it("covers the homeowner shell without swallowing public look-alikes", () => {
    expect(isHomeownerShellPath("/dashboard")).toBe(true);
    expect(isHomeownerShellPath("/onboarding?next=/join/household/x")).toBe(
      true
    );
    expect(isHomeownerShellPath("/issues/123")).toBe(true);
    // The Ask tab, added after the list was first written. A page inside the
    // (app) group that is missing from HOMEOWNER_SHELL_ROUTES only costs an
    // extra redirect, but the whole point of the list is that it does not
    // drift - see src/lib/supabase/guardedSegments.test.ts for the same
    // check against the middleware's own list.
    expect(isHomeownerShellPath("/ask")).toBe(true);
    expect(isHomeownerShellPath("/ask?q=leak")).toBe(true);
    // Anonymous emergency page, not the signed-in /emergency screen.
    expect(isHomeownerShellPath("/emergency-help")).toBe(false);
    // Neither shell owns these, so a role mismatch must leave them alone.
    expect(isHomeownerShellPath("/reset-password?step=update")).toBe(false);
    expect(isHomeownerShellPath("/join/household/abc")).toBe(false);
    expect(isHomeownerShellPath("/welcome/role")).toBe(false);
  });
});

describe("isSignupConfirmationPath", () => {
  it("is true only for the two signup pages' confirmation targets", () => {
    expect(isSignupConfirmationPath("/onboarding")).toBe(true);
    expect(isSignupConfirmationPath("/onboarding?next=/plus")).toBe(true);
    expect(isSignupConfirmationPath("/pro/onboarding")).toBe(true);
    expect(isSignupConfirmationPath("/dashboard")).toBe(false);
    expect(isSignupConfirmationPath("/reset-password?step=update")).toBe(false);
  });
});

describe("resolveAuthRole", () => {
  it("trusts an existing contractors row over the door they came through", () => {
    // The bug: a pro signing in with Google from /homeowner-signup, whose
    // button carries next=/onboarding. Inferring from `next` stamped them
    // homeowner and started the /onboarding -> /pro -> /dashboard loop.
    expect(
      resolveAuthRole({
        metadataRole: undefined,
        hasContractorRow: true,
        next: "/onboarding",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: true,
      redirect: "/pro",
      termsDoc: "pro_terms",
    });
  });

  it("re-stamps a pro whose metadata was already corrupted to homeowner", () => {
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: true,
        next: "/onboarding",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: true,
      redirect: "/pro",
      termsDoc: "pro_terms",
    });
  });

  it("infers homeowner for a genuinely new account at /onboarding", () => {
    expect(
      resolveAuthRole({
        metadataRole: undefined,
        hasContractorRow: false,
        next: "/onboarding",
      })
    ).toEqual({
      role: "homeowner",
      needsStamp: true,
      redirect: "/onboarding",
      termsDoc: "terms",
    });
  });

  it("infers contractor for a genuinely new account at /pro/onboarding", () => {
    expect(
      resolveAuthRole({
        metadataRole: null,
        hasContractorRow: false,
        next: "/pro/onboarding",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: true,
      redirect: "/pro/onboarding",
      termsDoc: "pro_terms",
    });
  });

  it("keeps an established homeowner on their own side of the app", () => {
    // Metadata homeowner, no company row: the /pro destination is wrong for
    // them, so correct it here instead of letting the pro layout bounce them.
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: false,
        next: "/pro/onboarding",
      })
    ).toEqual({
      role: "homeowner",
      needsStamp: false,
      redirect: "/dashboard",
      termsDoc: "terms",
    });
  });

  it("sends a contractor to /pro when next points at the homeowner shell", () => {
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: false,
        next: "/dashboard",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: false,
      redirect: "/pro",
      termsDoc: null,
    });
  });

  it("asks when there is no signal at all", () => {
    expect(
      resolveAuthRole({
        metadataRole: undefined,
        hasContractorRow: false,
        next: "/dashboard",
      })
    ).toEqual({
      role: null,
      needsStamp: false,
      redirect: "/welcome/role?next=%2Fdashboard",
      termsDoc: null,
    });
  });

  it("records no terms acceptance outside the signup confirmation flow", () => {
    // Password reset lands on this route too, and that user agreed to nothing.
    const decision = resolveAuthRole({
      metadataRole: "homeowner",
      hasContractorRow: false,
      next: "/reset-password?step=update",
    });
    expect(decision.termsDoc).toBeNull();
    expect(decision.redirect).toBe("/reset-password?step=update");
  });

  it("leaves role-neutral destinations alone for a contractor", () => {
    // Bouncing a pro off password reset would leave them unable to set a
    // password; a household QR invite is redeemable by either role.
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: true,
        next: "/reset-password?step=update",
      }).redirect
    ).toBe("/reset-password?step=update");
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: true,
        next: "/join/household/abc",
      }).redirect
    ).toBe("/join/household/abc");
  });

  it("leaves a dual-side account's stamped side and destination alone", () => {
    // The owner case: a contractors row, three properties, role=contractor.
    // Asking for the homeowner shell must land there, not be corrected to
    // /pro, and the stamp must not be rewritten.
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: true,
        hasPropertyRow: true,
        next: "/dashboard",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: false,
      redirect: "/dashboard",
      termsDoc: null,
    });
    // And the mirror: stamped homeowner, both rows, headed for the pro side.
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: true,
        hasPropertyRow: true,
        next: "/pro",
      })
    ).toEqual({
      role: "homeowner",
      needsStamp: false,
      redirect: "/pro",
      termsDoc: null,
    });
  });

  it("stamps a dual-side account only when it has no side on file", () => {
    expect(
      resolveAuthRole({
        metadataRole: undefined,
        hasContractorRow: true,
        hasPropertyRow: true,
        next: "/dashboard",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: true,
      redirect: "/dashboard",
      termsDoc: null,
    });
  });

  it("still corrects a pro who has no home of their own", () => {
    // hasPropertyRow defaults to false, so every existing caller and every
    // single-side pro keeps the old bounce to /pro.
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: true,
        hasPropertyRow: false,
        next: "/dashboard",
      }).redirect
    ).toBe("/pro");
  });

  it("does not restamp a role that is already correct", () => {
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: true,
        next: "/pro",
      })
    ).toEqual({
      role: "contractor",
      needsStamp: false,
      redirect: "/pro",
      termsDoc: null,
    });
  });
});

describe("landingFor", () => {
  const sides = (over: Partial<Sides> = {}): Sides => ({
    hasPro: false,
    hasHome: false,
    preferred: null,
    ...over,
  });

  it("sends an account with no side and no preference to the role picker", () => {
    // The regression this exists for: a blank account used to be dropped on
    // /onboarding, which decided "homeowner" for someone who never said so.
    expect(landingFor(sides())).toBe(ROLE_PICKER_PATH);
    expect(landingFor(sides())).toBe("/welcome/role");
  });

  it("keeps sending a preference with no side to that side's onboarding", () => {
    expect(landingFor(sides({ preferred: "homeowner" }))).toBe("/onboarding");
    expect(landingFor(sides({ preferred: "contractor" }))).toBe(
      "/pro/onboarding"
    );
  });

  it("honors the preferred side when the account actually has it", () => {
    expect(landingFor(sides({ preferred: "contractor", hasPro: true }))).toBe(
      "/pro"
    );
    expect(landingFor(sides({ preferred: "homeowner", hasHome: true }))).toBe(
      "/dashboard"
    );
  });

  it("falls back to a side that exists over an unbuilt preference", () => {
    expect(landingFor(sides({ preferred: "homeowner", hasPro: true }))).toBe(
      "/pro"
    );
    expect(landingFor(sides({ preferred: "contractor", hasHome: true }))).toBe(
      "/dashboard"
    );
  });

  it("never returns the picker for an account that has a side", () => {
    expect(landingFor(sides({ hasPro: true }))).toBe("/pro");
    expect(landingFor(sides({ hasHome: true }))).toBe("/dashboard");
    // Both sides, no preference: the company row is the more deliberate act.
    expect(landingFor(sides({ hasPro: true, hasHome: true }))).toBe("/pro");
  });
});
