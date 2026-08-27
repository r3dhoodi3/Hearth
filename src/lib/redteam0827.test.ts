// Red-team probes for the 2026-08-27 wave (commits 0774510, fb36deb).
// These assert what the code ACTUALLY does today, including where that is
// wrong. Every `expect` that documents a hole is marked HOLE with the attack
// it enables, so fixing the hole flips a named test rather than a mystery one.

import { describe, it, expect } from "vitest";
import { destinationForSignIn, resolveAuthRole } from "@/lib/roleRouting";
import { safeNextPath } from "@/lib/safeNext";
import { isAcceptablePublicText } from "@/lib/publicText";
import { checkoutCadence } from "@/lib/checkoutSubscriptionData";
import { trialApplies, billingTerms } from "@/lib/billingTerms";
import { isExcludedPath } from "@/lib/reviewPrompt";

const ORIGIN = "https://gethearth.vercel.app";

// What /auth/callback and /auth/confirm really do with the value: they hand it
// straight to new URL(value, origin) and redirect there.
function resolvesTo(path: string): string {
  return new URL(path, ORIGIN).href;
}

describe("open redirect via the inner ?next= of /onboarding", () => {
  // The outer ?next= is validated by safeNextPath (no control chars, no
  // backslash, must start with a single /). The INNER one is validated only by
  // innerNext() inside destinationForSignIn, which checks startsWith("/") and
  // !startsWith("//") and nothing else.
  it("outer safeNextPath still rejects the literal forms", () => {
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath("/\t/evil.com")).toBeNull();
    // ...but a percent-encoded inner next is just an ordinary relative path.
    expect(safeNextPath("/onboarding?next=/%5Cevil.com")).toBe(
      "/onboarding?next=/%5Cevil.com"
    );
  });

  // FIXED: innerNext() now re-runs safeNextPath's two other rules against the
  // DECODED inner value - no backslash anywhere, no C0 control character - and
  // both auth routes pass whatever the decision returns back through
  // safeNextPath before building the absolute URL.
  it("FIXED: a backslash in the inner next no longer escapes the origin", () => {
    const dest = destinationForSignIn("/onboarding?next=/%5Cevil.com", true);
    expect(dest).toBe("/dashboard");
    expect(resolvesTo(dest)).toBe(`${ORIGIN}/dashboard`);
  });

  it("FIXED: a tab in the inner next no longer escapes the origin", () => {
    const dest = destinationForSignIn("/onboarding?next=/%09/evil.com", true);
    expect(dest).toBe("/dashboard");
    expect(resolvesTo(dest)).toBe(`${ORIGIN}/dashboard`);
  });

  it("FIXED: a literal backslash is rejected too, not just the encoded form", () => {
    expect(destinationForSignIn("/onboarding?next=/\\evil.com", true)).toBe(
      "/dashboard"
    );
  });

  it("FIXED: closed through the full resolveAuthRole path a signed-in homeowner takes", () => {
    const d = resolveAuthRole({
      metadataRole: "homeowner",
      hasContractorRow: false,
      hasPropertyRow: true,
      next: "/onboarding?next=/%5Cevil.com",
    });
    expect(d.redirect).toBe("/dashboard");
    expect(resolvesTo(d.redirect)).toBe(`${ORIGIN}/dashboard`);
  });

  it("an account with no home is not affected (innerNext never runs)", () => {
    expect(destinationForSignIn("/onboarding?next=/%5Cevil.com", false)).toBe(
      "/onboarding?next=/%5Cevil.com"
    );
  });

  it("what the fix must preserve: a genuine household invite still passes", () => {
    expect(destinationForSignIn("/onboarding?next=/join/abc123", true)).toBe(
      "/join/abc123"
    );
    expect(destinationForSignIn("/onboarding?add=home", true)).toBe(
      "/onboarding?add=home"
    );
    expect(destinationForSignIn("/onboarding", true)).toBe("/dashboard");
  });
});

describe("weekly plan + 3-day trial", () => {
  it("weekly is the only Plus cadence that trials", () => {
    expect(trialApplies("weekly", true)).toBe(true);
    expect(trialApplies("monthly", true)).toBe(false);
    expect(trialApplies("yearly", true)).toBe(false);
  });

  it("an unreadable plan field falls back to monthly, never to the trialing cadence", () => {
    expect(checkoutCadence(undefined, "monthly")).toBe("monthly");
    expect(checkoutCadence("WEEKLY", "monthly")).toBe("monthly");
    expect(checkoutCadence(["weekly"], "monthly")).toBe("monthly");
    // But an exact "weekly" from any client does select the trial cadence.
    expect(checkoutCadence("weekly", "monthly")).toBe("weekly");
  });

  it("the disclosure for the trialing cadence names the real step-up", () => {
    const t = billingTerms("weekly", true);
    expect(t.summary).toContain("Free for 3 days");
    expect(t.summary).toContain("$1.99 a week");
  });
});

describe("moderation fold bypasses on public contractor text", () => {
  // Baselines: these are caught today.
  it("plain and NFKC-normalizable spellings are blocked", () => {
    expect(isAcceptablePublicText("Nigger Plumbing")).toBe(false);
    // mathematical bold - NFKC folds it to ASCII
    expect(isAcceptablePublicText("\u{1D427}\u{1D422}\u{1D420}\u{1D420}\u{1D41E}\u{1D42B} HVAC")).toBe(false);
    // zero-width space between letters
    expect(isAcceptablePublicText("n​igger HVAC")).toBe(false);
    // Cyrillic homoglyphs that ARE in the map
    expect(isAcceptablePublicText("сoon Roofing")).toBe(false);
  });

  it("FIXED: a combining diacritic is decomposed and stripped before matching", () => {
    expect(isAcceptablePublicText("nïgger Plumbing")).toBe(false);
  });

  it("FIXED: Unicode tag characters are stripped", () => {
    expect(isAcceptablePublicText("n\u{E0067}igger Plumbing")).toBe(false);
  });

  it("FIXED: combining enclosing marks are stripped", () => {
    expect(isAcceptablePublicText("n⃠igger Plumbing")).toBe(false);
  });

  it("FIXED: the Armenian o homoglyph is mapped to Latin o", () => {
    // Armenian small o (U+0585) reads as a Latin o in every UI font.
    expect(isAcceptablePublicText("cօօn Heating")).toBe(false);
  });

  it("FIXED: any bidi control character is rejected outright", () => {
    // The gate sees "reggin" and allows it; the browser renders the reversal.
    expect(isAcceptablePublicText("‮reggin Plumbing")).toBe(false);
  });

  it("the surname allowlist does not reopen the bare slurs it excluded", () => {
    expect(isAcceptablePublicText("Coons Heating")).toBe(true);
    expect(isAcceptablePublicText("Dick's Plumbing")).toBe(true);
    expect(isAcceptablePublicText("Spicer Roofing")).toBe(true);
    expect(isAcceptablePublicText("Coon Heating")).toBe(false);
    expect(isAcceptablePublicText("Spic Roofing")).toBe(false);
    // Pre-existing censor gap, unrelated to the allowlist: a suffix that is
    // not in SUFFIX makes the word-boundary lookahead fail.
    expect(isAcceptablePublicText("Dickhead Plumbing")).toBe(true);
  });
});

describe("review prompt exclusions", () => {
  it("FIXED: the excluded path is the route that exists, /signin", () => {
    expect(isExcludedPath("/signin")).toBe(true);
    expect(isExcludedPath("/sign-in")).toBe(false);
  });

  it("the exclusions that matter inside the (app) shell do hold", () => {
    expect(isExcludedPath("/plus")).toBe(true);
    expect(isExcludedPath("/feedback")).toBe(true);
    // A query string or a child route is still inside the excluded route.
    expect(isExcludedPath("/plus?reason=ask")).toBe(true);
    expect(isExcludedPath("/feedback/thanks")).toBe(true);
  });

  it("FIXED: segment-wise match, so an unrelated route is no longer excluded", () => {
    expect(isExcludedPath("/plusters")).toBe(false);
  });
});
