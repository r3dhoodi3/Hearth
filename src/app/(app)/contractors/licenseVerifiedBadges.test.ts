import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source test: both pages pull in the Supabase server client and
// getVerifiedUser() at module scope, which throw when imported outside a
// real server render, same reason src/app/pro/help/page.test.ts reads its
// target as text instead of importing it.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const applicantPage = src("./page.tsx");
const browsePage = src("./browse/page.tsx");

// 2026-08-30 research wave: a green "License verified" badge has to say what
// was checked and when, the same wording the public profile page
// (src/app/p/[id]/page.tsx) already pairs with it, imported from
// src/lib/guaranteeCopy.ts so none of the three surfaces can say it a
// different way.
describe("License verified badges state what was checked and when", () => {
  it("the applicant card (/contractors) imports and renders licenseVerifiedOnLine", () => {
    expect(applicantPage).toContain(
      'import { licenseVerifiedOnLine } from "@/lib/guaranteeCopy"'
    );
    const start = applicantPage.indexOf("License verified");
    // Two sibling spans follow "License verified": the chip itself, then the
    // one carrying the licence number and the checked-on sentence.
    const chipEnd = applicantPage.indexOf("</span>", start);
    const detailEnd = applicantPage.indexOf("</span>", chipEnd + 1);
    expect(applicantPage.slice(start, detailEnd)).toContain("licenseVerifiedOnLine(");
    // Never the old bare sentence with no date.
    expect(applicantPage).not.toContain("Checked against the CSLB public database.");
  });

  it("the browse card (/contractors/browse) imports and renders licenseVerifiedOnLine", () => {
    expect(browsePage).toContain(
      'import { licenseVerifiedOnLine } from "@/lib/guaranteeCopy"'
    );
    expect(browsePage).toContain("{pro.license_verified_at && (");
    expect(browsePage).toContain("licenseVerifiedOnLine(");
  });

  it("neither card renders a bare 'Verified' chip", () => {
    for (const [name, text] of [
      ["/contractors", applicantPage],
      ["/contractors/browse", browsePage],
    ] as const) {
      // A bare chip would read >Verified< with nothing else in the label;
      // every real chip in these files says "License verified" or
      // "License on file", not the word alone.
      expect(text, name).not.toMatch(/>Verified</);
    }
  });
});
