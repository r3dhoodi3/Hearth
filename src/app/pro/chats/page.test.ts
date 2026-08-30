import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// A source test, same reason src/app/pro/page.test.tsx is one: this page pulls
// in the service-role Supabase client at module scope (getCurrentContractor ->
// createAdminClient, which imports "server-only") and throws the moment it is
// imported outside a real server render.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");

// D13: a pro whose inbox is empty has nothing to do on this screen, and the
// answer is always the same one - go find a job to apply to. The list now
// carries that as a pinned row rather than leaving it to a sentence.
describe("pro Messages: Find clients row", () => {
  it("pins the row directly under the Ask Hearth row", () => {
    const ask = page.indexOf("<AskHearthRow");
    const find = page.indexOf("Find clients");
    const firstConvo = page.indexOf("{convos.map(");
    expect(ask).toBeGreaterThan(-1);
    expect(find).toBeGreaterThan(ask);
    expect(find).toBeLessThan(firstConvo);
  });

  it("goes to the open-jobs board through the shared constant, not a literal", () => {
    // Worker E moves the board to /pro/leads; PRO_LEADS_HREF is the one place
    // that flips when it does.
    expect(page).toContain("PRO_LEADS_HREF");
    expect(page).toContain("<Link\n                href={PRO_LEADS_HREF}");
  });

  it("looks like the other rows: icon chip, title, subtitle, chevron, 44px", () => {
    const row = page.slice(page.indexOf("Find clients") - 900, page.indexOf("Find clients") + 900);
    expect(row).toContain("min-h-11");
    expect(row).toContain("<Briefcase");
    expect(row).toContain("<ChevronRight");
    expect(row).toContain("Open jobs near you, ready to apply");
  });

  it("makes the empty state point at that row instead of repeating a link", () => {
    expect(page).toContain(
      "No conversations yet. Find clients to start one:"
    );
    // The old empty state carried its own inline "Leads" link, which is what
    // the pinned row above replaces.
    expect(page).not.toContain("page, and when a homeowner picks you");
  });
});

describe("pro Messages: unread pill on a phone", () => {
  // CEO pass D3: the "New" pill carries meaning (unread), so on a phone it
  // steps up to 14px instead of the old 12px. Desktop (base text-[10px]) is
  // unchanged.
  it("is 14px on a phone, 10px above sm", () => {
    expect(page).toContain(
      'text-[10px] font-semibold uppercase tracking-wide text-white max-sm:text-sm'
    );
    expect(page).not.toContain(
      'text-[10px] font-semibold uppercase tracking-wide text-white max-sm:text-xs'
    );
  });
});