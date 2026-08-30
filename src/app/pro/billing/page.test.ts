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
