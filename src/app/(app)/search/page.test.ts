import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source-level test: the page calls createClient() and getActiveProperty()
// at render time, both of which reach for next/headers cookies() and a
// service-role client, so importing it directly outside a real request
// throws, same reason the other page.tsx tests in this wave read source
// instead.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");

// 2026-08-30 research wave, owner's rule (2026-08-29): "ask hearth can just
// be on the messages tab to limit potential usage". /search used to render
// two inline AskHearth panes (nothing-matched and a trailing fallback); both
// are gone, and the empty state now points at Messages with the query
// carried along instead.
describe("/search has no inline Ask Hearth pane", () => {
  it("does not import or render the AskHearth component", () => {
    expect(page).not.toContain("AskHearth");
  });

  it("the nothing-matched state links to /chats with the question prefilled", () => {
    const start = page.indexOf("total === 0");
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf("</section>", start);
    const block = page.slice(start, end);
    // Same mechanism src/app/(app)/chats/page.tsx already reads
    // (searchParams.q -> initialQuestion) for the ask pane.
    expect(block).toContain("/chats?lead=ask-hearth&q=${encodeURIComponent(q)}");
    expect(block).toContain("Ask Hearth in Messages");
  });

  it("no trailing Ask Hearth section after the results groups", () => {
    // The old fallback lived right after the groups.map(...) block, keyed on
    // total > 0. If it comes back, this catches it even if the wording
    // around it changes.
    expect(page).not.toMatch(/q && total > 0[\s\S]{0,200}Ask Hearth/);
  });
});
