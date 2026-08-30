import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The pro side split into a Home tab and a Leads tab on 2026-08-29: /pro is
// Home, /pro/leads is the board, and the phone bottom bar carries five tabs
// with Home first (it was centred for one night; the owner asked for the
// best placement on 2026-08-30 and reading position won).
//
// These read the SOURCE rather than a render, on purpose and in a NODE
// environment rather than jsdom. ProNav is a server component whose LINKS
// array never reaches the DOM in a test (NavLinks has to be stubbed out - it
// opens a realtime unread subscription), and the active-state rule this
// depends on lives in NavLinks, a different component again. The order of the
// bottom bar and the /pro carve-out are both facts about the code, so the code
// is what gets asserted. Same approach as src/app/pro/leads/page.test.tsx.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const proNavSrc = src("./ProNav.tsx");
const navLinksSrc = src("./NavLinks.tsx");


describe("ProNav: five tabs, Home first", () => {
  it("lists all five destinations, with Home on /pro and Leads on /pro/leads", () => {
    expect(proNavSrc).toContain('{ href: "/pro", label: "Home", icon: "home" }');
    expect(proNavSrc).toContain(
      '{ href: "/pro/leads", label: "Leads", icon: "leads" }'
    );
    expect(proNavSrc).toContain('href: "/pro/chats"');
    expect(proNavSrc).toContain('href: "/pro/crm"');
    expect(proNavSrc).toContain('href: "/pro/business"');
    // "Leads" must no longer be the label on /pro: that route is Home now.
    expect(proNavSrc).not.toContain('{ href: "/pro", label: "Leads"');
  });

  it("puts Home FIRST in the phone bottom bar", () => {
    // Reading position for the primary destination: Home, Leads, Messages,
    // Clients, Business (Apple HIG / Material convention).
    const at = proNavSrc.indexOf("const BOTTOM_LINKS = [");
    expect(at).toBeGreaterThan(-1);
    const block = proNavSrc.slice(at, proNavSrc.indexOf("];", at));
    const order = [...block.matchAll(/LINKS\[(\d)\]/g)].map((m) => m[1]);
    // LINKS is [Home, Leads, Messages, Clients, Business], so the first slot
    // of the phone bar must be index 0.
    expect(order).toEqual(["0", "1", "2", "3", "4"]);
    expect(order[0]).toBe("0");
  });

  it("keeps every bottom-bar short label inside the 8-character budget", () => {
    // Five tabs share the width. NavLinks' own comment sets 8 characters as
    // the ceiling before truncation bites at 360px.
    for (const label of ["Home", "Leads", "Messages", "Clients", "Business"]) {
      expect(label.length).toBeLessThanOrEqual(8);
    }
  });

  it("lights Home on exactly /pro, never as a prefix of every pro route", () => {
    // Without this carve-out in NavLinks, /pro would be "active" on
    // /pro/leads, /pro/chats and every other pro screen at once.
    expect(navLinksSrc).toContain('l.href !== "/pro" &&');
    // ...while /pro/leads has no carve-out, so it lights on itself and its
    // own children through the startsWith branch.
    expect(navLinksSrc).not.toContain('l.href !== "/pro/leads"');
  });

  it("keeps Messages lit while the copilot is open", () => {
    expect(navLinksSrc).toContain('"/pro/chats": ["/pro/ask"]');
  });
});
