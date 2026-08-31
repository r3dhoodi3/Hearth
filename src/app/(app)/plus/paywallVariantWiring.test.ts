import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The soft-vs-hard paywall experiment (src/lib/paywallExperiment.ts): source
// pattern tests in the same shape as checkoutWiring.test.ts, and for the same
// reason - the checkout actions pull in "server-only" through the service-role
// client, so they cannot be imported and driven here. variantForUser itself IS
// driven for real in src/lib/paywallExperiment.test.ts; what these tests pin
// is the wiring, which is where the money risk lives:
//
//   1. Both checkout actions apply the variant SERVER-SIDE, next to the
//      existing eligibility checks, so a "hard" account cannot craft a request
//      that gets the trial anyway - and a "soft" one still can when eligible.
//   2. The pages that render trial copy gate it on the same variant, so the
//      screen and the charge cannot disagree.
//   3. The funnel events carry the variant, so the two conversion rates can
//      actually be compared afterwards.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const plusAction = src("./actions.ts");
const plusPage = src("./page.tsx");
const proAction = src("../../pro/plus/actions.ts");
const proPage = src("../../pro/plus/page.tsx");
const proLayout = src("../../pro/layout.tsx");
const lib = src("../../../lib/paywallExperiment.ts");

describe("the checkout actions honor the variant server-side", () => {
  it.each([
    ["homeowner Plus", plusAction],
    ["Hearth Pro", proAction],
  ])("%s derives the variant from the verified user id", (_l, source) => {
    expect(source).toContain(
      'import { variantForUser } from "@/lib/paywallExperiment";'
    );
    expect(source).toContain(
      "const paywallVariant = variantForUser(user.id);"
    );
  });

  it("the Plus trial branch ANDs the variant next to the existing checks", () => {
    // "hard" is one more reason the trial does not apply. The fail-closed
    // eligibility predicate and the risk gate stay in the same expression, so
    // a soft, eligible, low-risk buyer still gets the trial and everyone else
    // still does not.
    expect(plusAction).toContain(
      'trialApplies(plan, (await isPlusTrialEligible()) && risk.allowTrial && paywallVariant === "soft")'
    );
  });

  it("the Pro trial branch ANDs the variant next to the existing checks", () => {
    expect(proAction).toContain(
      'const wantsTrial = (await isProTrialEligible()) && risk.allowTrial && paywallVariant === "soft";'
    );
  });

  it("a hard-variant pro does not wake the dormant intro coupon either", () => {
    // Without this, !wantsTrial flips true on the hard arm and the $9.99
    // intro month attaches - a different offer, not the no-offer arm the
    // experiment is measuring, under consent copy quoting a trial.
    expect(proAction).toContain(
      'const introOffered = !wantsTrial && paywallVariant === "soft" && plan === "pro_monthly" && !existing;'
    );
  });
});

describe("the pages gate their trial copy on the same variant", () => {
  it("/plus folds the variant into trialEligible", () => {
    expect(plusPage).toContain("const paywallVariant = variantForUser(viewer?.id);");
    expect(plusPage).toMatch(
      /const trialEligible =\s*\(await isPlusTrialEligible\(\)\) && \(risk\?\.allowTrial \?\? true\) &&\s*paywallVariant === "soft"/
    );
  });

  it("/pro/plus folds the variant into trialEligible", () => {
    expect(proPage).toContain(
      'const trialEligible = !sub && (risk?.allowTrial ?? true) && paywallVariant === "soft";'
    );
  });

  it("the pro shell hands the takeover the variant without touching who sees it", () => {
    // `eligible` (never trialed, not a member) stays the sole gate on WHO the
    // takeover appears for; the variant only picks its copy.
    expect(proLayout).toContain("const trialEligible = !member && !proSub;");
    expect(proLayout).toContain(
      "<ProTrialNudge eligible={trialEligible} userId={contractor.user_id ?? null} variant={paywallVariant} />"
    );
  });
});

describe("the funnel events carry the variant", () => {
  it("checkout_started and pro_checkout_started both stamp it", () => {
    for (const source of [plusAction, proAction]) {
      expect(source).toMatch(
        /trackServerEvent\(user\.id, "(pro_)?checkout_started", \{\s*plan,\s*variant: paywallVariant,\s*\}\)/
      );
    }
  });

  it("the paywall render events stamp it on both sides", () => {
    expect(plusPage).toMatch(
      /trackServerEvent\(viewer\?\.id \?\? null, "paywall_seen", \{\s*reason: paywallReason,\s*variant: paywallVariant,\s*\}\)/
    );
    expect(proPage).toContain('"pro_paywall_seen"');
    expect(proPage).toContain("variant: paywallVariant,");
  });
});

describe("the experiment can be ended by env var alone", () => {
  it("the lib documents and reads PAYWALL_EXPERIMENT", () => {
    expect(lib).toContain("process.env.PAYWALL_EXPERIMENT");
    expect(lib).toContain('if (mode === "soft" || mode === "hard") return mode;');
  });
});
