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

// CEO pass D2 (Breadcrumbs part 2): pro/billing had no trail. Label matches
// the ProNav profile menu entry verbatim ("Billing") so the two never say
// something different.
describe("pro billing: breadcrumb trail", () => {
  it("imports and renders Breadcrumbs before the page content", () => {
    expect(page).toContain('import Breadcrumbs from "@/components/Breadcrumbs"');
    const crumb = page.indexOf("<Breadcrumbs");
    const heading = page.indexOf('<h1 className="text-2xl font-semibold');
    expect(crumb).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(crumb);
  });

  it("goes Home > Billing", () => {
    expect(page).toContain('{ label: "Home", href: "/pro" }');
    expect(page).toContain('{ label: "Billing" }');
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

  it("is the last thing the server page renders, with plain-data rows", () => {
    const activityTag = page.indexOf("<ActivityList");
    expect(activityTag).toBeGreaterThan(-1);
    // Nothing after it: an element rendered past this point would sit beyond
    // the same budget and take the deferral in its place.
    const tail = page.slice(activityTag + 1);
    expect(tail).not.toMatch(/<[A-Za-z]/);
    // Rows are strings and booleans, resolved here rather than in the client.
    expect(page).toContain("label: txLabel(t.type)");
    expect(page).toContain("when: new Date(t.created_at).toLocaleString()");
  });

  it("keeps the guarantee paragraph inside that component", () => {
    expect(activity).toContain("GHOST_PROTECTION_GUARANTEE");
    expect(page).not.toContain("GHOST_PROTECTION_GUARANTEE");
  });
});
