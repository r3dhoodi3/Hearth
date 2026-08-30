import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// page.tsx pulls in the service-role Supabase client at module scope (via
// getCurrentContractor -> createAdminClient), which imports "server-only"
// and throws the moment it's imported outside a real server component
// render. So, like src/lib/aiUsage.test.ts and src/lib/constants.test.ts,
// this reads the source instead of importing the module.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");

// The "Asked for you" card moved OUT of this page on 2026-08-29: the Home tab
// shows a two-item preview of the same thing, so the card became a component
// both pages render rather than inline JSX that would drift. Its assertions
// read that file whole; nothing about the markup changed.
const directRequestCard = src("../DirectRequestCard.tsx");

// Slices out the open-job card's per-item block (from its first new local
// const down through its returned <li>) so an assertion can be scoped to just
// that card instead of matching anywhere in this 1200+ line file.
function sliceFrom(marker: string, length: number): string {
  const start = page.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, start + length);
}

const openJobCard = sliceFrom(
  "const feeGlance = feeGlanceLabel(fee, feeStr);\n" +
    "              const glanceLine2 = [\n" +
    "                j.timing",
  12500
);

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
      expect(detailsVar).toContain("issue_description");
      expect(detailsVar).toContain("JobPhotoStrip");
      expect(detailsVar).toContain("chips.map");
      expect(detailsVar).toContain("scope.map");
      expect(detailsVar).toContain("postedAgo(");
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
    expect(page).toContain("canAfford={balance >= fee}");
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
      expect(card).toContain("{feeGlance}");
      expect(card).toContain("glanceLine2");
    }
  });
});

// The heading row after the Home / Leads split (2026-08-29). D9's "See open
// jobs" button used to sit here; on the Leads tab it was a link to itself, so
// finding work is the Home tab's primary quick action now (asserted in
// src/app/pro/page.test.tsx).
describe("pro leads: heading row", () => {
  it("keeps the h1 as 'Your leads' with the open-jobs anchor on this page", () => {
    expect(page).toContain(">Your leads</h1>");
    expect(page).toContain('<section id="open-jobs"');
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
    expect(page).toContain("PRO_LEADS_HREF");
    expect(page).toContain("? PRO_LEADS_HREF");
    expect(page).toContain("`${PRO_LEADS_HREF}?sort=${o.value}`");
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
    expect(page).not.toContain("buildSetupItems(");
  });

  it("drops the 'Your results' card and its computed counts", () => {
    // The phrase itself still appears in this page's own comments, recording
    // where the card used to live and why - what must be gone is the actual
    // stat-label markup and the counts it displayed.
    expect(page).not.toContain('<p className="stat-label">Your results</p>');
    expect(page).not.toContain("appliedCount");
    expect(page).not.toContain("wonCount");
    expect(page).not.toContain("totalSpentCents");
  });

  it("drops the Active jobs / Wallet balance stat cards", () => {
    expect(page).not.toContain(">Active jobs</p>");
    expect(page).not.toContain(">Wallet balance</p>");
  });

  it("drops the Clients button from beside the heading", () => {
    expect(page).not.toContain('<Link href="/pro/crm"');
    expect(page).not.toContain(">Clients</Link>");
  });

  it("shrinks the low-funds banner to one compact line instead of a card with a button", () => {
    expect(page).not.toContain("earn bonus credit");
    expect(page).not.toContain("<Link href=\"/pro/billing\" className=\"btn-primary shrink-0\">");
    expect(page).toContain("Low on funds.");
    expect(page).toContain("to keep applying.");
  });

  it("keeps every section the board itself needs", () => {
    expect(page).toContain("<LeadsRealtime contractorId={contractor.id} />");
    expect(page).toContain('<section id="open-jobs"');
    expect(page).toContain("Asked for you");
    expect(page).toContain("Your jobs <span");
    expect(page).toContain("Pending applications");
    expect(page).toContain("Not selected");
    expect(page).toContain("<ApplyJobButton");
  });

  it("no longer fetches the applications/transactions rows the results card needed", () => {
    expect(page).not.toContain('.from("lead_applications")');
    expect(page).not.toContain('.from("wallet_transactions")');
    // The grants read (spendable-bonus cap) is still needed for the Apply
    // button's canAfford math, so walletQueryPlan itself stays.
    expect(page).toContain("walletQueryPlan(");
  });
});
