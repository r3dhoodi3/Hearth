import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source-level test, same reason src/app/pro/help/page.test.ts is one: this
// page reads getVerifiedUser() and isContractor(), which pull in Supabase
// clients that throw when imported outside a real server render.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");

// 2026-08-30 research wave: the guarantee, no-contract, and no-bidding-wars
// lines all have to be present, and they have to be the canonical strings
// from src/lib/guaranteeCopy.ts, not a retyped paraphrase that could drift.
describe("/pros states the guarantee, no-contract, and no-bidding-wars facts from the canonical source", () => {
  it("imports the canonical constants instead of hardcoding the sentences", () => {
    expect(page).toContain("GHOST_PROTECTION_GUARANTEE");
    expect(page).toContain("FIRST_APPLICATION_GUARANTEE");
    expect(page).toContain("NO_CONTRACT_LINE");
    expect(page).toContain("NO_BIDDING_WARS_LINE");
    expect(page).toContain('from "@/lib/guaranteeCopy"');
  });

  it("renders NO_BIDDING_WARS_LINE inside the job-card promise", () => {
    const start = page.indexOf('title: "The price is on the job card"');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf("},", start);
    expect(page.slice(start, end)).toContain("${NO_BIDDING_WARS_LINE}");
  });

  it("renders NO_CONTRACT_LINE inside the no-subscription promise", () => {
    const start = page.indexOf('title: "No subscription required"');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf("},", start);
    expect(page.slice(start, end)).toContain("${NO_CONTRACT_LINE}");
  });

  it("still renders the ghost-protection and first-application guarantees", () => {
    expect(page).toContain("{GHOST_PROTECTION_GUARANTEE}");
    expect(page).toContain("{FIRST_APPLICATION_GUARANTEE}");
    expect(page).toContain("{CREDIT_NOT_CASH_LINE}");
  });
});
