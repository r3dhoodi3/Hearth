import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { nestedStreamHoles, deferredRowRefs } from "@/lib/streamHoles";

// page.tsx pulls in the service-role Supabase client at module scope (via
// getCurrentContractor -> createAdminClient), which imports "server-only"
// and throws the moment it's imported outside a real server component
// render. So, like src/lib/aiUsage.test.ts and src/lib/constants.test.ts,
// this reads the source instead of importing the module.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
// Every card list moved into this client component on 2026-08-30 for streaming
// reasons (see the last describe in this file), so the markup assertions read
// it now. page.tsx still owns the data, the fee maths and the sort.
const board = src("./LeadsBoard.tsx");

// The "Asked for you" card moved OUT of this page on 2026-08-29: the Home tab
// shows a two-item preview of the same thing, so the card became a component
// both pages render rather than inline JSX that would drift. Its assertions
// read that file whole; nothing about the markup changed.
const directRequestCard = src("../DirectRequestCard.tsx");

// Slices out the open-job card's per-item block (the whole map callback) so an
// assertion can be scoped to just that card rather than matching anywhere in
// the file.
function sliceBetween(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

const openJobCard = sliceBetween(
  board,
  "{openJobs.map((j) => {",
  "{/* ---- Active jobs"
);

// The page module's own top-level JSX return, used to bound the view-model
// slice below. Anchored on the newline and the two-space indent so a nested
// `return (data ?? [])` inside one of the query closures cannot match it.
const RETURN_MARKER = ["", "  return (", ""].join("\n");

describe("pro lead card phone density (0128)", () => {
  it("folds the direct-request card's detail behind a collapsed-by-default <details>", () => {
    // A real <details> disclosure, not force-opened - native <details> starts
    // collapsed unless it carries the `open` attribute, and this never sets
    // one, so it is collapsed by default.
    expect(directRequestCard).toContain('<details className="group sm:hidden">');
    expect(directRequestCard).not.toMatch(/<details[^>]*\bopen\b/);
    expect(directRequestCard).toContain("Details");
    // The same content (the shared detailsContent variable) is always
    // visible above sm, via a second, non-collapsing copy.
    expect(directRequestCard).toContain(
      '<div className="hidden space-y-3 sm:block">{detailsContent}</div>'
    );
  });

  it("folds the open-job card's detail behind a collapsed-by-default <details>", () => {
    expect(openJobCard).toContain('<details className="group sm:hidden">');
    expect(openJobCard).not.toMatch(/<details[^>]*\bopen\b/);
    expect(openJobCard).toContain("Details");
    expect(openJobCard).toContain(
      '<div className="hidden space-y-3 sm:block">{detailsContent}</div>'
    );
  });

  it("keeps description, photo strip, and quality/scope chips inside the folded detailsContent", () => {
    for (const card of [directRequestCard, openJobCard]) {
      const varStart = card.indexOf("const detailsContent = (");
      const varEnd = card.indexOf("return (", varStart);
      expect(varStart).toBeGreaterThan(-1);
      expect(varEnd).toBeGreaterThan(varStart);
      const detailsVar = card.slice(varStart, varEnd);
      // The open-job card reads a resolved view model now, so the field names
      // differ in case; both still render the same four things plus the
      // posted-ago line, which is computed on the server and passed in.
      expect(detailsVar).toMatch(/issue_description|j\.description/);
      expect(detailsVar).toContain("JobPhotoStrip");
      expect(detailsVar).toMatch(/chips\.map|j\.chips\.map/);
      expect(detailsVar).toMatch(/scope\.map|j\.scope\.map/);
      expect(detailsVar).toContain("postedAgoLabel");
    }
  });

  it("leaves DirectRequestActions and ApplyJobButton outside the <details>, unconditioned by the toggle", () => {
    const directDetailsClose = directRequestCard.lastIndexOf("</details>");
    const directActionIdx = directRequestCard.indexOf("<DirectRequestActions");
    expect(directDetailsClose).toBeGreaterThan(-1);
    expect(directActionIdx).toBeGreaterThan(directDetailsClose);

    const openDetailsClose = openJobCard.lastIndexOf("</details>");
    const applyIdx = openJobCard.indexOf("<ApplyJobButton");
    expect(openDetailsClose).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(openDetailsClose);

    // The applicant-count line and the full/conflict states also stay
    // outside the fold, exactly as before.
    expect(openJobCard.indexOf("spots taken")).toBeGreaterThan(openDetailsClose);
  });

  it("does not touch fee math, sorting, or wallet-balance checks", () => {
    expect(page).toContain("agingLeadFee(");
    expect(page).toContain("walletQueryPlan(");
    expect(page).toContain('sort === "fee"');
    expect(page).toContain('sort === "deal"');
    // Still the same comparison, resolved on the server and handed to the
    // Apply button as a boolean.
    expect(page).toContain("canAfford: balance >= fee");
    expect(openJobCard).toContain("canAfford={j.canAfford}");
  });

  it("keeps the desktop header (sm and up) rendering the original category/severity/fee row unchanged", () => {
    for (const card of [directRequestCard, openJobCard]) {
      expect(card).toMatch(/<div className="hidden flex-wrap items-center gap-2 sm:flex">/);
    }
    // Severity, ownership-verified, and the aging-deal/intro-fee chips are
    // still there for the desktop row - only reorganized under the sm:flex
    // wrapper, never deleted.
    expect(openJobCard).toContain("Ownership verified");
    expect(openJobCard).toContain("aging deal");
    expect(directRequestCard).toContain("First big-ticket lead");
  });

  it("gives the phone glance line a category+fee row and a fallback for a missing/zero fee", () => {
    // feeGlanceLabel moved to src/lib/proLeadCard.ts when the card became a
    // component two pages share; the rule it encodes is unchanged.
    const helpers = src("../../../lib/proLeadCard.ts");
    expect(helpers).toContain(
      "export function feeGlanceLabel(fee: number, feeStr: string): string {"
    );
    expect(helpers).toContain('return "Free";');
    expect(helpers).toContain('return "New lead";');
    for (const card of [directRequestCard, openJobCard]) {
      expect(card).toContain('<div className="sm:hidden">');
      expect(card).toMatch(/\{feeGlance\}|\{j\.feeGlance\}/);
      expect(card).toContain("glanceLine2");
    }
    // The glance line itself is still built the same way, now on the server.
    expect(page).toContain("feeGlance: feeGlanceLabel(fee, feeStr),");
  });
});

// The heading row after the Home / Leads split (2026-08-29). D9's "See open
// jobs" button used to sit here; on the Leads tab it was a link to itself, so
// finding work is the Home tab's primary quick action now (asserted in
// src/app/pro/page.test.tsx).
describe("pro leads: heading row", () => {
  it("keeps the h1 as 'Your leads' with the open-jobs anchor on this route", () => {
    expect(page).toContain(">Your leads</h1>");
    expect(board).toContain('<section id="open-jobs"');
  });

  it("no longer offers a 'See open jobs' button that links to itself", () => {
    // The button, not the words: the comment where it used to sit still names
    // it, and that comment is the record of why it went.
    expect(page).not.toContain(
      "#open-jobs`} className=" + '"btn-primary"'
    );
  });

  it("routes the sort links through PRO_LEADS_HREF, never a literal /pro", () => {
    // The board lives at /pro/leads now, so a hard-coded "/pro" on a sort tap
    // would bounce the pro onto the Home screen.
    expect(board).toContain("PRO_LEADS_HREF");
    expect(board).toContain("? PRO_LEADS_HREF");
    expect(board).toContain("`${PRO_LEADS_HREF}?sort=${o.value}`");
    // All three options, in the same order, still rendered from one list.
    expect(board).toContain('{ value: "new", label: "Newest" }');
    expect(board).toContain('{ value: "fee", label: "Cheapest fee" }');
    expect(board).toContain('{ value: "deal", label: "Biggest deal" }');
  });

  it("tracks lead_viewed with a count, after the closed-job sweep and before the sort", () => {
    // docs/ANALYTICS.md: count only, never a job id or any lead detail. Fires
    // on the final `open` array (after closedIds is applied), never the raw
    // openJobs the RPC returned - the pro never sees the closed ones.
    expect(page).toContain(
      'await trackServerEvent(contractor.user_id, "lead_viewed", {\n    count: open.length,\n  });'
    );
    const closedSweep = page.indexOf("open = open.filter((j) => !closedIds.has(j.id));");
    const tracked = page.indexOf('"lead_viewed"');
    const sort = page.indexOf("const sort =");
    expect(closedSweep).toBeGreaterThan(-1);
    expect(tracked).toBeGreaterThan(closedSweep);
    expect(tracked).toBeLessThan(sort);
  });
});

// CEO pass item A (2026-08-30): the Leads tab used to render the Home-era
// chrome above the board (setup checklist, "Your results" text wall, the
// active-jobs/wallet stat cards, a "Clients" button beside the heading) -
// all of it now lives on Home (or, for Clients, its own tab), so a pro no
// longer scrolls past a second copy of the same chrome to reach an open job.
describe("pro leads: board only, chrome removed", () => {
  it("drops the setup checklist and its builder call", () => {
    expect(page).not.toContain("SetupChecklist");
    // The board's header comment names the component as a fellow streaming
    // fix, so this asserts on the element, not the word.
    expect(board).not.toContain("<SetupChecklist");
    expect(page).not.toContain("buildSetupItems(");
  });

  it("drops the 'Your results' card and its computed counts", () => {
    // The phrase itself still appears in this page's own comments, recording
    // where the card used to live and why - what must be gone is the actual
    // stat-label markup and the counts it displayed.
    expect(board).not.toContain('<p className="stat-label">Your results</p>');
    expect(page).not.toContain("appliedCount");
    expect(page).not.toContain("wonCount");
    expect(page).not.toContain("totalSpentCents");
  });

  it("drops the Active jobs / Wallet balance stat cards", () => {
    for (const file of [page, board]) {
      expect(file).not.toContain(">Active jobs</p>");
      expect(file).not.toContain(">Wallet balance</p>");
    }
  });

  it("drops the Clients button from beside the heading", () => {
    for (const file of [page, board]) {
      expect(file).not.toContain('<Link href="/pro/crm"');
      expect(file).not.toContain(">Clients</Link>");
    }
  });

  it("shrinks the low-funds banner to one compact line instead of a card with a button", () => {
    expect(board).not.toContain("earn bonus credit");
    expect(board).not.toContain("<Link href=\"/pro/billing\" className=\"btn-primary shrink-0\">");
    expect(board).toContain("Low on funds.");
    expect(board).toContain("to keep applying.");
  });

  it("keeps every section the board itself needs", () => {
    expect(page).toContain("<LeadsRealtime contractorId={contractor.id} />");
    expect(board).toContain('<section id="open-jobs"');
    expect(board).toContain("Asked for you");
    expect(board).toContain("Your jobs <span");
    expect(board).toContain("Pending applications");
    expect(board).toContain("Not selected");
    expect(board).toContain("<ApplyJobButton");
    expect(board).toContain("<DirectRequestCard");
  });

  it("no longer fetches the applications/transactions rows the results card needed", () => {
    expect(page).not.toContain('.from("lead_applications")');
    expect(page).not.toContain('.from("wallet_transactions")');
    // The grants read (spendable-bonus cap) is still needed for the Apply
    // button's canAfford math, so walletQueryPlan itself stays.
    expect(page).toContain("walletQueryPlan(");
  });
});

// The regression this half of the file exists for. See the long comment at the
// top of LeadsBoard.tsx: as server markup the four card lists sat past the
// point where React Flight starts deferring elements into rows of their own,
// and on a pro with a real board (6 open jobs, a direct request, 8 assigned
// jobs, 5 applications) this page's own Flight row carried 19 deferrals, which
// the served document turned into 11 nested `<template id="P:n">` holes and 12
// `$RS(...)` fill scripts - the shape that accompanies the React #418
// hydration failure on the pro pages.
//
// A unit test cannot see a stream, so these assert the properties that keep
// the stream shape: the whole body is one client module, and the page hands it
// plain data rather than rendering the cards itself.
describe("pro leads stays one client component with plain-data props", () => {
  it("LeadsBoard carries the \"use client\" directive", () => {
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = board
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("so does the direct-request card it renders", () => {
    const firstStatement = directRequestCard
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("leaves no card markup in the server page", () => {
    // The tail of the page's Flight row is what gets chopped, so the page must
    // end at the single <LeadsBoard> element. A <ul>/<li>/<section> back in
    // here would put elements after LeadsBoard's props, past the budget, and
    // the deferrals would return.
    expect(page).toContain("<LeadsBoard");
    for (const tag of ["<ul", "<li", "<section", "<ApplyJobButton", "<DirectRequestCard", "<details"]) {
      expect(page).not.toContain(tag);
    }
  });

  it("passes every card as resolved strings, numbers and booleans", () => {
    // A ReactNode or a bare closure in a view model would be an element to
    // defer (or an unserializable prop) all over again.
    for (const marker of [
      "const openJobVms: OpenJobVM[] = open.map((j) => {",
      "const assignedJobs: AssignedJobVM[] = assigned.map((l) => ({",
    ]) {
      expect(page).toContain(marker);
    }
    const vmBlock = page.slice(
      page.indexOf("const directItems: DirectRequestItem[]"),
      page.indexOf(RETURN_MARKER)
    );
    expect(vmBlock.length).toBeGreaterThan(0);
    expect(vmBlock).not.toMatch(/<[A-Za-z]/);
  });

  it("resolves everything clock- or locale-dependent on the server", () => {
    // agingLeadFee, introFeeFor and postedAgo all read Date.now(). Recomputing
    // them during hydration could disagree with what SSR printed, which is the
    // mismatch class this whole change exists to remove.
    for (const helper of ["agingLeadFee(", "introFeeFor(", "postedAgo("]) {
      expect(page).toContain(helper);
      expect(board).not.toContain(helper);
    }
  });
});

// The same check against a real streamed response. It needs a running server
// and a signed-in pro cookie, so it is opt-in. Point it at a pro whose board
// has open jobs, assigned jobs and ideally a direct request:
//
//   HEARTH_LEADS_STREAM_URL=http://localhost:3105 \
//   HEARTH_LEADS_STREAM_COOKIE='sb-...' npx vitest run src/app/pro/leads/page.test.tsx
const streamBase = process.env.HEARTH_LEADS_STREAM_URL;

describe.skipIf(!streamBase)("served /pro/leads has no deferred rows or nested holes", () => {
  async function get(path: string) {
    const res = await fetch(streamBase + path, {
      headers: { cookie: process.env.HEARTH_LEADS_STREAM_COOKIE ?? "" },
    });
    const html = await res.text();
    return { res, html };
  }

  // Row "6" is the page's own Flight row under the pro layout; rows 0/3 and
  // the low hex ids belong to the Next.js shell and defer on every route,
  // fixed or not, so this asserts on the page row rather than the total.
  const PAGE_ROW = "6";

  it("default sort: page row is emitted whole", async () => {
    const { res, html } = await get("/pro/leads");
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });

  it("cheapest-fee sort: page row is emitted whole", async () => {
    const { res, html } = await get("/pro/leads?sort=fee");
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });
});
