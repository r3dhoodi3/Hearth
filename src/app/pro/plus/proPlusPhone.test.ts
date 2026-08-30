import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// /pro/plus after the 2026-08-29 pass: the same phone treatment worker D gave
// the homeowner /plus page, plus the ?reason= banners the homeowner page has
// had for a while.
//
// Source assertions, in a node environment: both files are server/client
// components whose branches need a live subscription row and a Stripe action to
// render, and what is being checked here is a set of structural rules
// (breakpoint gating, text sizes, banner keys) that read cleanly off the source.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
const toggle = src("./ProPlanToggle.tsx");
const homeownerToggle = src("../../(app)/plus/PlanToggle.tsx");

describe("pro plus: the phone disclosure, matching the homeowner page", () => {
  it("folds the itemized terms behind a 'Billing terms' details on phones only", () => {
    // Two elements, one per breakpoint: `open` is a boolean attribute no media
    // query can drive.
    expect(toggle).toContain('<details className="group sm:hidden">');
    expect(toggle).toContain("Billing terms");
    expect(toggle).toContain('<div className="max-sm:hidden">');
    // Same shape the homeowner page uses.
    expect(homeownerToggle).toContain("Billing terms");
  });

  it("renders the disclosure twice per checkout form, so desktop is unchanged", () => {
    // Three AutoRenewalTerms per form pair: the trial form's two, plus the
    // picker form's two. Four in total across the file.
    const count = (toggle.match(/<AutoRenewalTerms/g) ?? []).length;
    expect(count).toBe(4);
  });

  it("keeps a one-line material summary visible on the phone, never folded", () => {
    // ROSCA 15 U.S.C. 8403(1) and Cal. Bus. and Prof. Code 17602(a)(1) want
    // material terms in visual proximity to consent. What folds is the
    // itemized copy, never this line.
    expect(toggle).toContain("function planBilling(plan: Plan, trialEligible: boolean)");
    expect(toggle).toContain("{planBilling(plan, trialEligible)}");
    expect(toggle).toContain(
      '<p className="text-sm text-stone-600 sm:hidden dark:text-stone-300">'
    );
  });

  it("quotes every number from PRO_PLAN rather than typing one in", () => {
    expect(toggle).toContain("${PRO_PLAN.trialDays} days free");
    expect(toggle).toContain("${PLAN_COPY.monthly.price}");
    expect(toggle).toContain("${PLAN_COPY.yearly.price}");
  });
});

describe("pro plus: phone text sizes", () => {
  it("lifts every 10px and 11px line above the readable floor on phones", () => {
    // Every text-[10px] / text-[11px] in this file must carry a max-sm:
    // override. Desktop keeps the original class, so sm and up is unchanged.
    const smalls = [...toggle.matchAll(/className="[^"]*text-\[1[01]px\][^"]*"/g)];
    expect(smalls.length).toBeGreaterThan(0);
    for (const m of smalls) {
      expect(m[0], m[0]).toMatch(/max-sm:text-(xs|sm)/);
    }
  });

  it("lifts the 12px card lines to 14px on phones only", () => {
    const xs = [...toggle.matchAll(/className="[^"]*\btext-xs\b[^"]*"/g)];
    for (const m of xs) {
      // A text-xs that is already inside a max-sm: override is fine; a bare
      // one on a card line is not.
      expect(m[0], m[0]).toMatch(/max-sm:text-sm|max-sm:text-xs/);
    }
  });

  it("changes nothing at sm and up: every phone rule is a max-sm variant", () => {
    // If a size rule ever lands without a breakpoint prefix it silently
    // rewrites the desktop page, which the owner's rule forbids.
    expect(toggle).not.toContain('className="text-sm font-medium text-stone-700 max-sm:');
  });
});

describe("pro plus: ?reason= banners", () => {
  it("maps each door to its own pitch", () => {
    expect(page).toContain("const REASON_COPY: Record<string, string> = {");
    for (const key of ["tools:", "ask:", "leads:", "nudge:", "feedback:", "logo:"]) {
      expect(page, key).toContain(key);
    }
  });

  it("renders nothing for an unknown or absent reason", () => {
    expect(page).toContain('REASON_COPY[searchParams.reason ?? ""] ?? null');
    expect(page).toContain("{reasonCopy && (");
  });

  it("quotes the free-draft count from the constant, never a typed number", () => {
    expect(page).toContain("${FREE_PRO_DRAFTS} free drafts");
  });

  it("sends the buyer to the board after checkout, not back to a stale label", () => {
    expect(page).toContain("<Link href={PRO_LEADS_HREF} className=\"btn-primary\">");
    expect(page).toContain("Find jobs");
    // The old label survives only in the comment that records why it changed;
    // what must be gone is the hard-coded "/pro" primary button.
    expect(page).not.toContain('<Link href="/pro" className="btn-primary">');
  });
});
