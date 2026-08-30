import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { nestedStreamHoles, deferredRowRefs } from "@/lib/streamHoles";

// A source test, same reason src/app/pro/leads/page.test.tsx is one: this page
// pulls in the service-role Supabase client at module scope
// (getCurrentContractor -> createAdminClient, which imports "server-only") and
// throws the moment it is imported outside a real server render.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
// The whole body moved into this client component on 2026-08-30 for streaming
// reasons (see the last describe in this file), so the markup assertions read
// it now. page.tsx still owns every query and every derived number.
const view = src("./CrmView.tsx");

// The page module's own top-level JSX return, used to bound the view-model
// slice below. Anchored on the newline and the two-space indent so a nested
// `return (data ?? [])` inside one of the query closures cannot match it.
const RETURN_MARKER = ["", "  return (", ""].join("\n");

describe("pro CRM: the pipeline is unchanged", () => {
  it("keeps the four stages in order, defined once on the server", () => {
    expect(page).toContain('{ value: "lead", label: "Lead" }');
    expect(page).toContain('{ value: "quoted", label: "Quoted" }');
    expect(page).toContain('{ value: "won", label: "Won" }');
    expect(page).toContain('{ value: "lost", label: "Lost" }');
    // Not copied into the client module: it takes them as a prop, so the
    // Add-a-client picker and the grouped list can never disagree.
    expect(view).not.toContain('{ value: "quoted", label: "Quoted" }');
    expect(view).toContain("stageOptions.map((s) => (");
    expect(page).toContain("stageOptions={STAGES}");
  });

  it("still groups the client list by stage and drops empty stages", () => {
    expect(page).toContain("const groups = STAGES.map((s) => ({");
    expect(page).toContain(".filter((g) => g.items.length > 0)");
  });

  it("keeps both server-action forms and their pending labels", () => {
    // Imported straight from the "use server" module, which a client component
    // may do - that keeps the action references out of the props.
    expect(view).toContain('from "./actions"');
    expect(view).toContain("action={addClientAction}");
    expect(view).toContain("action={trackLeadAction}");
    expect(view).toContain('pendingLabel="Adding…"');
    expect(view).toContain('pendingLabel="Tracking…"');
  });

  it("keeps the add form keyed on the added-client count, not the client count", () => {
    // A Track tap on a suggested job below must not blank a half-typed name in
    // this form. See the long comment beside the key.
    expect(page).toContain("const addedClientCount = clients.filter((c) => !c.lead_id).length;");
    expect(view).toContain("key={addedClientCount}");
  });

  it("keeps the search form a plain GET to /pro/crm", () => {
    expect(view).toContain('<form action="/pro/crm" method="get"');
    expect(view).toContain('name="q"');
    expect(view).toContain("No clients match that search.");
  });

  it("keeps the Pro teaser honest: shipped features apart from the roadmap list", () => {
    expect(view).toContain("PRO_CRM_FEATURES");
    expect(view).toContain("PLANNED_CRM_FEATURES");
    expect(view).toContain("What&apos;s coming");
    expect(view).toContain("planned, not in the app yet");
    // The trial is only offered to a pro with no pro-side subscriptions row.
    expect(page).toContain("hasProSubscriptionRow={Boolean(proSub)}");
    expect(view).toContain('? "See Hearth Pro"');
  });
});

// The regression this half of the file exists for. See the long comment at the
// top of CrmView.tsx: as server markup the stage tiles, the follow-up list, the
// job suggestions, the grouped client list and the Pro teaser cards sat past
// the point where React Flight starts deferring elements into rows of their
// own. Measured on a pro with 7 clients and 8 jobs, this page's own Flight row
// carried 17 deferrals, which the served document turned into 9 nested
// `<template id="P:n">` holes and 10 `$RS(...)` fill scripts - the shape that
// accompanies the React #418 hydration failure on the pro pages.
describe("pro CRM stays one client component with plain-data props", () => {
  it("CrmView carries the \"use client\" directive", () => {
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = view
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("leaves no list markup in the server page", () => {
    // The tail of the page's Flight row is what gets chopped, so the page must
    // end at the single <CrmView> element.
    expect(page).toContain("<CrmView");
    for (const tag of ["<ul", "<li", "<section", "<form", "<ClientRow", "<Link"]) {
      expect(page).not.toContain(tag);
    }
  });

  it("passes the view models as resolved strings, numbers and booleans", () => {
    const vmBlock = page.slice(
      page.indexOf("const stageTiles = STAGES.map"),
      page.indexOf(RETURN_MARKER)
    );
    expect(vmBlock.length).toBeGreaterThan(0);
    expect(vmBlock).not.toMatch(/<[A-Za-z]/);
  });

  it("formats the clock- and locale-dependent bits on the server", () => {
    // toLocaleDateString reads the runtime's locale and time zone, so a client
    // component formatting it during hydration could print something different
    // from what SSR sent - the exact mismatch class this change removes.
    expect(page).toContain("toLocaleDateString()");
    expect(view).not.toContain("toLocaleDateString(");
    expect(page).toContain("const todayStr = new Date().toISOString().slice(0, 10);");
    expect(view).not.toContain("new Date()");
  });
});

// The same check against a real streamed response. It needs a running server
// and a signed-in pro cookie, so it is opt-in. Point it at a pro with tracked
// clients and at least one job to suggest:
//
//   HEARTH_CRM_STREAM_URL=http://localhost:3105 \
//   HEARTH_CRM_STREAM_COOKIE='sb-...' npx vitest run src/app/pro/crm/page.test.ts
const streamBase = process.env.HEARTH_CRM_STREAM_URL;

describe.skipIf(!streamBase)("served /pro/crm has no deferred rows or nested holes", () => {
  async function get(path: string) {
    const res = await fetch(streamBase + path, {
      headers: { cookie: process.env.HEARTH_CRM_STREAM_COOKIE ?? "" },
    });
    const html = await res.text();
    return { res, html };
  }

  // Row "6" is the page's own Flight row under the pro layout; rows 0/3 and
  // the low hex ids belong to the Next.js shell and defer on every route,
  // fixed or not, so this asserts on the page row rather than the total.
  const PAGE_ROW = "6";

  it("full list: page row is emitted whole", async () => {
    const { res, html } = await get("/pro/crm");
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });

  it("search branch: page row is emitted whole", async () => {
    const { res, html } = await get("/pro/crm?q=a");
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });
});
