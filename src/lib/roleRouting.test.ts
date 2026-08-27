import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  destinationForSignIn,
  isFirstHomeSetupPath,
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

  // =========================================================================
  // SIGNING IN MUST NEVER LAND ON THE ADD-A-HOME FLOW.
  //
  // Google and Apple use ONE button for both sign-up and sign-in, and
  // /homeowner-signup builds it with next=/onboarding (oauthNextPath there).
  // So an EXISTING homeowner who tapped "Continue with Apple" on that page
  // came back to /onboarding, which for an account that already owns a home is
  // the "Add another home" screen - and on the free plan that screen is the
  // cap wall: "Your first home is free. Adding another home is part of Hearth
  // Plus." A person who did nothing but sign in was told to upgrade.
  //
  // The cap belongs to the explicit add-a-home action alone, so the sign-in
  // landing never goes near it.
  // =========================================================================
  it("sends an existing homeowner signing in to their dashboard, not the claim-a-home page", () => {
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: false,
        hasPropertyRow: true,
        next: "/onboarding",
      })
    ).toEqual({
      role: "homeowner",
      needsStamp: false,
      redirect: "/dashboard",
      termsDoc: "terms",
    });
  });

  it("still sends a brand-new homeowner to the claim-a-home page", () => {
    // hasPropertyRow false: nothing to land on yet, so onboarding IS the
    // right destination. This is the case the signup funnel was built for.
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: false,
        hasPropertyRow: false,
        next: "/onboarding",
      }).redirect
    ).toBe("/onboarding");
    expect(
      resolveAuthRole({
        metadataRole: null,
        hasContractorRow: false,
        next: "/onboarding?ref=abc",
      }).redirect
    ).toBe("/onboarding?ref=abc");
  });

  it("honors an explicit add-another-home intent", () => {
    // ?add=home is the one signal that someone MEANT to add a home
    // (ProNav's "Add your home", setPreferredSideAction). Someone who was
    // bounced to /signin off that URL and came back through OAuth asked for
    // it, so they get it - cap wall included, which is where the cap belongs.
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: false,
        hasPropertyRow: true,
        next: "/onboarding?add=home",
      }).redirect
    ).toBe("/onboarding?add=home");
  });

  it("still delivers a household invite that rode along inside ?next=", () => {
    // A housemate who already owns a home scans the QR invite while signed
    // out: /homeowner-signup?next=/join/household/<token> builds
    // next=/onboarding?next=/join/household/<token>. Handing them straight to
    // the redemption page is exactly what /onboarding does with that URL.
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: false,
        hasPropertyRow: true,
        next: "/onboarding?next=%2Fjoin%2Fhousehold%2Fabc",
      }).redirect
    ).toBe("/join/household/abc");
    // And any other destination the funnel parked in there.
    expect(
      resolveAuthRole({
        metadataRole: "homeowner",
        hasContractorRow: false,
        hasPropertyRow: true,
        next: "/onboarding?next=%2Fplus&ref=neighbor",
      }).redirect
    ).toBe("/plus");
  });

  it("never follows an off-site or nested value from the inner ?next=", () => {
    // The inner value is attacker-influenceable in exactly the way the outer
    // one is, and it has not been through safeNextPath. Anything that is not
    // a plain relative path of ours falls back to the dashboard, and
    // /onboarding inside /onboarding would only walk back into the cap wall.
    for (const inner of [
      "https%3A%2F%2Fevil.example.com",
      "%2F%2Fevil.example.com",
      "%2Fonboarding",
      "not-a-path",
    ]) {
      expect(
        resolveAuthRole({
          metadataRole: "homeowner",
          hasContractorRow: false,
          hasPropertyRow: true,
          next: `/onboarding?next=${inner}`,
        }).redirect
      ).toBe("/dashboard");
    }
  });

  it("sends a dual-side account that already owns a home to the dashboard too", () => {
    // The owner's own account: a company row, homes, role=contractor. Signing
    // in through the homeowner door must not show them the cap wall either.
    expect(
      resolveAuthRole({
        metadataRole: "contractor",
        hasContractorRow: true,
        hasPropertyRow: true,
        next: "/onboarding",
      }).redirect
    ).toBe("/dashboard");
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

// The rule above only works if /auth/callback actually ASKS whether this
// account owns a home before it lets resolveAuthRole decide. That lookup used
// to be skipped for everyone without a contractors row, which is every
// ordinary homeowner - so hasPropertyRow was false for exactly the people the
// cap wall was hitting. A source-text check, the same trick
// src/lib/homeValueCallers.test.ts uses: the wiring compiles and looks right
// either way, so nothing else would catch it going back.
describe("isFirstHomeSetupPath", () => {
  it("matches the claim-a-home wizard and nothing that merely starts like it", () => {
    expect(isFirstHomeSetupPath("/onboarding")).toBe(true);
    expect(isFirstHomeSetupPath("/onboarding?add=home")).toBe(true);
    expect(isFirstHomeSetupPath("/pro/onboarding")).toBe(false);
    expect(isFirstHomeSetupPath("/dashboard")).toBe(false);
  });
});

describe("destinationForSignIn", () => {
  it("leaves every destination alone for an account with no home yet", () => {
    expect(destinationForSignIn("/onboarding", false)).toBe("/onboarding");
    expect(destinationForSignIn("/onboarding?ref=abc", false)).toBe(
      "/onboarding?ref=abc"
    );
  });

  it("leaves destinations that are not the claim-a-home page alone", () => {
    expect(destinationForSignIn("/dashboard", true)).toBe("/dashboard");
    expect(destinationForSignIn("/plus?reason=home_limit", true)).toBe(
      "/plus?reason=home_limit"
    );
    // The pro wizard has its own guard (it redirects an existing contractor to
    // /pro), and it is not the home cap, so this rule does not touch it.
    expect(destinationForSignIn("/pro/onboarding", true)).toBe(
      "/pro/onboarding"
    );
  });

  it("redirects an existing homeowner off the claim-a-home page", () => {
    expect(destinationForSignIn("/onboarding", true)).toBe("/dashboard");
    expect(destinationForSignIn("/onboarding?ref=neighbor", true)).toBe(
      "/dashboard"
    );
  });
});

// The open redirect this rule nearly shipped. The OUTER ?next= is checked by
// safeNextPath, which rejects backslashes and control characters - but
// "/onboarding?next=/%5Cevil.com" contains neither: it is an ordinary relative
// path of ours, and safeNextPath passes it. URLSearchParams.get() then DECODES
// the inner value, so innerNext() is handed "/\evil.com", and the WHATWG URL
// parser normalizes that backslash into a slash: new URL("/\\evil.com",
// origin) is https://evil.com/. The %09 (tab) form works the same way, since
// the parser strips C0 controls anywhere in the string. innerNext therefore has
// to re-run BOTH rules against the decoded value.
describe("destinationForSignIn: the inner ?next= cannot leave the origin", () => {
  const ORIGIN = "https://gethearth.vercel.app";
  // What the auth routes really do with the returned value.
  const resolvesTo = (path: string) => new URL(path, ORIGIN).href;

  it("rejects a percent-encoded backslash in the inner next", () => {
    const dest = destinationForSignIn("/onboarding?next=/%5Cevil.com", true);
    expect(dest).toBe("/dashboard");
    expect(resolvesTo(dest)).toBe(`${ORIGIN}/dashboard`);
  });

  it("rejects a percent-encoded tab (any C0 control) in the inner next", () => {
    const dest = destinationForSignIn("/onboarding?next=/%09/evil.com", true);
    expect(dest).toBe("/dashboard");
    expect(resolvesTo(dest)).toBe(`${ORIGIN}/dashboard`);
  });

  it("rejects a literal backslash, wherever in the value it sits", () => {
    expect(destinationForSignIn("/onboarding?next=/\\evil.com", true)).toBe(
      "/dashboard"
    );
    expect(destinationForSignIn("/onboarding?next=/a/b\\c", true)).toBe(
      "/dashboard"
    );
  });

  it("still rejects the forms that were already rejected", () => {
    for (const inner of [
      "https%3A%2F%2Fevil.example.com",
      "%2F%2Fevil.example.com",
      "%2Fonboarding",
      "not-a-path",
    ]) {
      expect(
        destinationForSignIn(`/onboarding?next=${inner}`, true),
        inner
      ).toBe("/dashboard");
    }
  });

  it("what the fix must not break: real inner destinations still pass", () => {
    // The household QR invite is the whole reason innerNext exists.
    expect(destinationForSignIn("/onboarding?next=/join/abc123", true)).toBe(
      "/join/abc123"
    );
    expect(
      destinationForSignIn("/onboarding?next=/join/household/abc", true)
    ).toBe("/join/household/abc");
    expect(destinationForSignIn("/onboarding?next=%2Fplus", true)).toBe(
      "/plus"
    );
    // The one explicit "I am adding a home" intent still reaches the wizard.
    expect(destinationForSignIn("/onboarding?add=home", true)).toBe(
      "/onboarding?add=home"
    );
    expect(destinationForSignIn("/onboarding", true)).toBe("/dashboard");
  });

  it("is closed through the full sign-in path too, not just the helper", () => {
    for (const next of [
      "/onboarding?next=/%5Cevil.com",
      "/onboarding?next=/%09/evil.com",
    ]) {
      expect(
        resolveAuthRole({
          metadataRole: "homeowner",
          hasContractorRow: false,
          hasPropertyRow: true,
          next,
        }).redirect,
        next
      ).toBe("/dashboard");
    }
  });
});

// The rule above only works if the two auth routes actually ASK whether this
// account owns a home. In /auth/callback that lookup used to be skipped for
// everyone without a contractors row, which is every ordinary homeowner - so
// hasPropertyRow was false for exactly the people the cap wall was hitting,
// and /auth/confirm never asked at all. A source-text check, the same trick
// src/lib/homeValueCallers.test.ts uses: the wiring compiles and looks right
// either way, so nothing else would catch it going back.
describe("auth route wiring", () => {
  const read = (route: string) =>
    readFileSync(
      fileURLToPath(new URL(`../app/auth/${route}/route.ts`, import.meta.url)),
      "utf8"
    );

  it("looks up the property row in /auth/callback when the destination is the claim-a-home page", () => {
    expect(read("callback")).toMatch(
      /hasContractorRow \|\| isFirstHomeSetupPath\(next\)[\s\S]{0,120}propertyRowExists/
    );
  });

  it("applies the same rule in /auth/confirm", () => {
    const source = read("confirm");
    expect(source).toContain("isFirstHomeSetupPath(next)");
    expect(source).toMatch(
      /destinationForSignIn\(next, await propertyRowExists\(data\.user\.id\)\)/
    );
  });

  // Belt and braces for the inner-?next= open redirect above: innerNext()
  // rejects the escapes, and the two lines that actually build an absolute URL
  // re-check whatever the decision handed back. Either lock alone closes it;
  // both together mean a future rewrite of the decision cannot reopen it.
  it("re-validates the resolved destination before building the URL", () => {
    expect(read("callback")).toMatch(
      /safeNextPath\(decision\.redirect\) \?\? "\/dashboard"/
    );
    expect(read("callback")).toMatch(
      /NextResponse\.redirect\(new URL\(redirectPath, origin\)\)/
    );
    const confirm = read("confirm");
    expect(confirm).toMatch(/safeNextPath\(destination\) \?\? "\/dashboard"/);
    expect(confirm).toMatch(/new URL\(safeDestination, requestOrigin\(request\)\)/);
  });
});
