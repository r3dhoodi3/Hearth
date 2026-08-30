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

// CEO pass D2 (Breadcrumbs part 2): the plain "Back to clients" link is
// replaced by the shared trail, Home > Clients > the client's name - the
// exact "Home > Clients > a name" example Breadcrumbs.tsx's own file
// comment gives for a page this deep.
describe("pro client detail: breadcrumb trail replaces Back to clients", () => {
  it("imports and renders Breadcrumbs before the h1", () => {
    expect(page).toContain('import Breadcrumbs from "@/components/Breadcrumbs"');
    const crumb = page.indexOf("<Breadcrumbs");
    const heading = page.indexOf("{client.client_name}");
    expect(crumb).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(crumb);
  });

  it("goes Home > Clients > the client's name", () => {
    expect(page).toContain('{ label: "Home", href: "/pro" }');
    expect(page).toContain('{ label: "Clients", href: "/pro/crm" }');
    expect(page).toContain("{ label: client.client_name }");
  });

  it("no longer renders the old plain Back to clients link", () => {
    expect(page).not.toContain("Back to clients");
  });
});
