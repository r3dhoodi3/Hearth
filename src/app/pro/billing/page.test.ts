import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source test, same reason src/app/pro/page.test.tsx is one: this page pulls
// in the service-role Supabase client at module scope (getCurrentContractor
// -> createAdminClient, which imports "server-only") and throws the moment
// it is imported outside a real server component render.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
const activity = src("./ActivityList.tsx");
// The whole body moved into this client component for streaming reasons (see
// the last describe in this file), so markup assertions read it now.
const view = src("./BillingView.tsx");

// CEO pass D2 (Breadcrumbs part 2): pro/billing had no trail. Label matches
// the ProNav profile menu entry verbatim ("Billing") so the two never say
// something different.
describe("pro billing: breadcrumb trail", () => {
  it("imports and renders Breadcrumbs before the page content", () => {
    expect(view).toContain('import Breadcrumbs from "@/components/Breadcrumbs"');
    const crumb = view.indexOf("<Breadcrumbs");
    const heading = view.indexOf('<h1 className="text-2xl font-semibold');
    expect(crumb).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(crumb);
  });

  it("goes Home > Billing", () => {
    expect(view).toContain('{ label: "Home", href: "/pro" }');
    expect(view).toContain('{ label: "Billing" }');
  });
});

// Streaming regression, the same one src/app/pro/chats/page.test.ts guards.
// The Activity list is the tail of this page's Flight row, so as server markup
// it sat past React's 3200-byte deferral budget: measured on a pro with eight
// wallet transactions, the served HTML carried three `<template id="P:n">`
// holes nested inside its own <ul>/<li>. As a client module with plain-data
// props there is nothing there to defer. See ActivityList.tsx.
describe("pro billing: Activity stays one client component", () => {
  it("ActivityList carries the \"use client\" directive", () => {
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = activity
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("is the last thing the view renders, with plain-data rows", () => {
    const activityTag = view.indexOf("<ActivityList rows=");
    expect(activityTag).toBeGreaterThan(-1);
    // Nothing after it: an element rendered past this point would sit beyond
    // the same budget and take the deferral in its place.
    const tail = view.slice(activityTag + 1);
    expect(tail).not.toMatch(/<[A-Za-z]/);
    // Rows are strings and booleans, resolved on the server rather than in
    // the client.
    expect(page).toContain("label: txLabel(t.type)");
    expect(page).toContain("when: new Date(t.created_at).toLocaleString()");
  });

  it("keeps the guarantee paragraph inside that component", () => {
    expect(activity).toContain("GHOST_PROTECTION_GUARANTEE");
    expect(page).not.toContain("GHOST_PROTECTION_GUARANTEE");
    expect(view).not.toContain("GHOST_PROTECTION_GUARANTEE");
  });
});

// The rest of the same regression, found on live on 2026-08-30: with Activity
// already extracted, /pro/billing's page row STILL deferred one element -
// <ActivityList> itself, because the intro copy, the balances and the deposit
// section ahead of it had spent the 3200-byte budget by byte ~4200. Whatever
// renders last takes the deferral, so the whole body had to move.
describe("pro billing: the page renders one client element (DBG3 follow-up)", () => {
  it("BillingView carries the \"use client\" directive", () => {
    const firstStatement = view
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("leaves no markup in the server page", () => {
    expect(page).toContain("<BillingView");
    for (const tag of ["<div", "<section", "<h1", "<h2", "<p ", "<ul", "<Link"]) {
      expect(page, tag).not.toContain(tag);
    }
  });

  it("formats the money and the timestamps on the server", () => {
    // dollars() and toLocaleString both stay in the page; the view takes
    // finished strings, so hydration cannot disagree about either.
    expect(page).toContain("cashLabel={dollars(cash)}");
    expect(page).toContain("bonusLabel={dollars(bonus)}");
    expect(view).not.toContain("toLocaleString");
    expect(view).toContain("cashLabel: string;");
  });
});

// Strip every max-sm:-prefixed token from a class string and sort what's
// left. Two class lists with the same stripped result render identically at
// sm and up, even if one carries extra phone-only tokens the other doesn't.
function stripMaxSm(classes: string): string[] {
  return classes
    .split(/\s+/)
    .filter((c) => c.length > 0 && !c.startsWith("max-sm:"))
    .sort();
}

// Owner's ask, 2026-08-30: "add credit" should not need scrolling on a
// phone. The two balance cards used to stack (grid, sm:grid-cols-2 - one
// column below sm); now they sit side by side below sm too, with the
// padding and number size tightened to buy back the height a second row
// used to cost. Desktop keeps the exact same two-column grid it always had.
describe("pro billing: balance cards sit side by side on a phone", () => {
  it("balances section is a 2-column grid below sm as well as from sm up", () => {
    // CR3#10: gap-3 -> gap-2, tightening the stacked-card rhythm further so
    // "Add credit" sits closer to the fold.
    const sectionClass =
      "grid gap-4 max-sm:grid-cols-2 max-sm:gap-2 sm:grid-cols-2";
    expect(view).toContain(`<section className="${sectionClass}">`);
    // Stripped of max-sm: tokens, this is byte-identical to the pre-existing
    // desktop class list ("grid gap-4 sm:grid-cols-2").
    expect(stripMaxSm(sectionClass)).toEqual(stripMaxSm("grid gap-4 sm:grid-cols-2"));
  });

  it("tightens padding and number size below sm without touching the desktop tokens", () => {
    // CR3#10: p-3 -> p-2.5, same rhythm tightening as the gap above.
    const cashCardClass = "card-hero max-sm:p-2.5";
    const bonusCardClass =
      "card border-amber-200 bg-amber-50 max-sm:p-2.5 dark:border-amber-500/30 dark:bg-amber-500/15";
    expect(view).toContain(`<div className="${cashCardClass}">`);
    expect(view).toContain(`<div className="${bonusCardClass}">`);
    expect(stripMaxSm(cashCardClass)).toEqual(stripMaxSm("card-hero"));
    expect(stripMaxSm(bonusCardClass)).toEqual(
      stripMaxSm(
        "card border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/15"
      )
    );

    const cashNumberClass =
      "stat-number mt-1 text-4xl max-sm:text-xl text-hearth-900 dark:text-hearth-200";
    const bonusNumberClass =
      "stat-number mt-1 text-2xl max-sm:text-xl text-amber-900 dark:text-amber-300";
    expect(view).toContain(`<p className="${cashNumberClass}">`);
    expect(view).toContain(`<p className="${bonusNumberClass}">`);
    expect(stripMaxSm(cashNumberClass)).toEqual(
      stripMaxSm("stat-number mt-1 text-4xl text-hearth-900 dark:text-hearth-200")
    );
    expect(stripMaxSm(bonusNumberClass)).toEqual(
      stripMaxSm("stat-number mt-1 text-2xl text-amber-900 dark:text-amber-300")
    );
  });
});

// Owner's ask: the deposit section (h2 + DepositForm, whose preset buttons
// are near its top) already sits immediately after the balances section, and
// ProUpgradeCta already renders after the whole <DepositForm /> element (it
// is a sibling further down in the non-member branch) - so on a phone it was
// already below the buttons and needed no reordering. This guards that
// relative order against drifting back above the form.
describe("pro billing: deposit section follows balances, ProUpgradeCta follows the form", () => {
  it("the Add credit h2 and DepositForm come right after the balances section", () => {
    const balancesIdx = view.indexOf("{/* Balances");
    const depositHeadingIdx = view.indexOf(">Add credit<");
    const formIdx = view.indexOf("<DepositForm");
    expect(balancesIdx).toBeGreaterThan(-1);
    expect(depositHeadingIdx).toBeGreaterThan(balancesIdx);
    expect(formIdx).toBeGreaterThan(depositHeadingIdx);
  });

  it("ProUpgradeCta renders after the DepositForm element, not before it", () => {
    const formIdx = view.indexOf("<DepositForm");
    const ctaIdx = view.indexOf("<ProUpgradeCta");
    expect(formIdx).toBeGreaterThan(-1);
    expect(ctaIdx).toBeGreaterThan(formIdx);
  });
});
