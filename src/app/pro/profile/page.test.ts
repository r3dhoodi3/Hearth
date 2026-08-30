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

// CEO pass D2 (Breadcrumbs part 2): pro/profile had no trail. One route
// holds all four tabs (public/page/projects/security), so the crumb names
// the route itself, not whichever tab is open - it is rendered here, in the
// server component, above the client ProfileTabs, so it is always in the
// served HTML regardless of which tab is selected client-side. Label
// matches the ProNav profile menu entry verbatim ("Edit business profile").
describe("pro profile: breadcrumb trail", () => {
  it("imports and renders Breadcrumbs above the client ProfileTabs", () => {
    expect(page).toContain('import Breadcrumbs from "@/components/Breadcrumbs"');
    const crumb = page.indexOf("<Breadcrumbs");
    const tabs = page.indexOf("<ProfileTabs");
    expect(crumb).toBeGreaterThan(-1);
    expect(tabs).toBeGreaterThan(crumb);
  });

  it("goes Home > Edit business profile", () => {
    expect(page).toContain('{ label: "Home", href: "/pro" }');
    expect(page).toContain('{ label: "Edit business profile" }');
  });
});
