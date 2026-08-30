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
