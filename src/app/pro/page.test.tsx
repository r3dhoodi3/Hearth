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

// Slices out one lead card's per-item block (from its first new local const
// down through its returned <li>) so an assertion can be scoped to just that
// card instead of matching anywhere in this 1200+ line file. Both cards
// declare an identical `const feeGlance = feeGlanceLabel(...)` line, so the
// marker has to include the very next, card-specific line (d.timing vs
// j.timing) to land on the right one.
function sliceFrom(marker: string, length: number): string {
  const start = page.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, start + length);
}

const directRequestCard = sliceFrom(
  "const feeGlance = feeGlanceLabel(fee, feeStr);\n" +
    "              const glanceLine2 = [\n" +
    "                d.timing",
  9500
);
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
    expect(page).toContain(
      "function feeGlanceLabel(fee: number, feeStr: string): string {"
    );
    expect(page).toContain('return "Free";');
    expect(page).toContain('return "New lead";');
    for (const card of [directRequestCard, openJobCard]) {
      expect(card).toContain('<div className="sm:hidden">');
      expect(card).toContain("{feeGlance}");
      expect(card).toContain("glanceLine2");
    }
  });
});
