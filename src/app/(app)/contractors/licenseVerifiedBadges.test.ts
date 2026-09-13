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
// C8 (2026-09-07): the browse card's markup (and the licenseVerifiedOnLine
// import) moved out of page.tsx into a client component, BrowseProsBoard.tsx,
// so filter taps could filter the already-fetched list in the browser
// instead of round-tripping the server on every tap. Same card, same import,
// different file.
const browsePage = src("./browse/BrowseProsBoard.tsx");

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

// Insurance is private (2026-09-12). It used to show publicly as a
// self-reported chip on the browse card and as half of the "on file" badge on
// /p/<id>. A pro's proof of insurance now lives only on the Credentials tab of
// /pro/profile; a homeowner who wants it asks the pro for a copy. The RPC still
// returns has_insurance, so the guard is that nothing RENDERS it.
describe("insurance is never shown publicly", () => {
  const publicPage = src("../../p/[id]/page.tsx");

  it("the browse card renders no insurance chip", () => {
    expect(browsePage).not.toContain("Insurance (self-reported)");
    expect(browsePage).not.toContain("{pro.has_insurance &&");
  });

  it("the public profile badge reflects the license alone", () => {
    expect(publicPage).toContain("const showBadge = profile.has_license;");
    expect(publicPage).not.toContain("profile.has_license || profile.has_insurance");
    expect(publicPage).not.toContain("insurance (self-reported)");
    expect(publicPage).not.toContain("badgeMentionsInsurance");
    expect(publicPage).toContain('const badgeLabel = "License on file";');
  });
});

// The outbound Yelp / Google review links (0110/0111/0113) are gone from every
// user-facing surface as of 2026-09-12: an outbound link is a route off the
// platform before any lead record exists. The columns stay, and so does
// saveCompanyAction's missing-field-safe handling of them; only the UI went.
describe("no surface offers an outbound review link", () => {
  const publicPage = src("../../p/[id]/page.tsx");

  it("the browse card renders no Yelp or Google link", () => {
    expect(browsePage).not.toContain("Reviews on Yelp");
    expect(browsePage).not.toContain("Reviews on Google");
    expect(browsePage).not.toContain("{pro.yelp_url &&");
    expect(browsePage).not.toContain("{pro.google_reviews_url &&");
  });

  it("the public profile page renders no 'See our reviews' buttons", () => {
    expect(publicPage).not.toContain("See our reviews");
    expect(publicPage).not.toContain("{profile.yelp_url &&");
    expect(publicPage).not.toContain("{profile.google_reviews_url &&");
    expect(publicPage).not.toContain("href={profile.yelp_url}");
  });
});
