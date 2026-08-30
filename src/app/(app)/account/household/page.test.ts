import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source test, same reason src/app/pro/crm/page.test.ts is one: this page
// pulls in getVerifiedUser -> createClient at module scope and throws the
// moment it is imported outside a real server component render.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");

// RB wave (2026-08-30, CR4#7): the household card names the caretaking case
// (a parent's home, a managed rental) explicitly, since that's the one part
// of household sharing that creates a genuinely new account rather than a
// second login inside one that already exists.
describe("household: names the caretaking use case", () => {
  it("keeps the new copy line alongside the existing explainer paragraphs", () => {
    expect(page).toContain(
      "Managing a parent&apos;s home or a rental? Add them so you both see"
    );
    // Still there: the existing lines this one was added next to, not a
    // replacement for them.
    expect(page).toContain(
      "A member can see and manage the day-to-day: systems, tasks, issues,"
    );
    expect(page).toContain("Plus is personal, so a member doesn&apos;t get the owner&apos;s");
  });
});
