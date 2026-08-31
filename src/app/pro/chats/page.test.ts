import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { nestedStreamHoles, deferredRowRefs } from "@/lib/streamHoles";

// A source test, same reason src/app/pro/page.test.tsx is one: this page pulls
// in the service-role Supabase client at module scope (getCurrentContractor ->
// createAdminClient, which imports "server-only") and throws the moment it is
// imported outside a real server render.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
// Both panes moved into this client component for streaming reasons (see the
// last two describes in this file), so the markup assertions read it now.
const view = src("./ChatsView.tsx");

// D13: a pro whose inbox is empty has nothing to do on this screen, and the
// answer is always the same one - go find a job to apply to. The list now
// carries that as a pinned row rather than leaving it to a sentence.
describe("pro Messages: Find clients row", () => {
  it("pins the row directly under the Ask Hearth row", () => {
    const ask = view.indexOf("<AskHearthRow");
    // Anchored past the Ask Hearth row: the Active tab's empty-state copy
    // ("... Find clients to start one ...") also carries the phrase, earlier
    // in the file, and it is not the row this test is about.
    const find = view.indexOf("Find clients", ask);
    // The conversation rows are split into Active / Closed for ChatListTabs
    // now; the Active list is the first one rendered.
    const firstConvo = view.indexOf("{activeChats.map(");
    expect(ask).toBeGreaterThan(-1);
    expect(find).toBeGreaterThan(ask);
    expect(find).toBeLessThan(firstConvo);
  });

  it("goes to the open-jobs board through the shared constant, not a literal", () => {
    // Worker E moves the board to /pro/leads; PRO_LEADS_HREF is the one place
    // that flips when it does.
    expect(view).toContain("PRO_LEADS_HREF");
    expect(view).toContain("href={PRO_LEADS_HREF}");
  });

  it("looks like the other rows: icon chip, title, subtitle, chevron, 44px", () => {
    // Same anchor as above: the pinned row, not the empty-state sentence.
    const at = view.indexOf("Find clients", view.indexOf("<AskHearthRow"));
    const row = view.slice(at - 900, at + 900);
    expect(row).toContain("min-h-11");
    expect(row).toContain("<Briefcase");
    expect(row).toContain("<ChevronRight");
    expect(row).toContain("Open jobs near you, ready to apply");
  });

  it("makes the empty state point at that row instead of repeating a link", () => {
    expect(view).toContain("No open conversations yet. Find clients to start one:");
    // The old empty state carried its own inline "Leads" link, which is what
    // the pinned row above replaces.
    expect(view).not.toContain("page, and when a homeowner picks you");
  });
});

// W14: "when they apply for a job and they send a message, let the message
// also show in their Messages box." The application a pro paid to send used to
// live only on the homeowner's applicant list.
describe("pro Messages: applications waiting on the homeowner", () => {
  it("reads the pro's own applications through the user client, not admin", () => {
    // my_applications (SECURITY DEFINER) for the lead's category and status,
    // lead_applications for the message the pro wrote. RLS is the gate on
    // both, so nothing here may reach for the service-role client.
    expect(page).toContain('rpc("my_applications")');
    expect(page).toContain('.from("lead_applications")');
    expect(page).toContain('.select("id, message")');
    expect(page).not.toContain("createAdminClient");
  });

  it("lists only applications that are still waiting", () => {
    // Still 'applied' (nobody picked yet) and not refunded (the fee already
    // came back, so there is nothing waiting on).
    const block = page.slice(page.indexOf("const pendingApps"));
    expect(block).toContain('a.status === "applied"');
    expect(block).toContain("!a.refunded_at");
  });

  it("dedupes by lead id, so a picked pro sees the conversation instead", () => {
    // The moment the homeowner picks this pro the lead is assigned and shows
    // up in convos; the application row for it has to disappear rather than
    // sit under its own thread.
    expect(page).toContain("const convoLeadIds = new Set(convos.map((l) => l.id))");
    expect(page).toContain("!convoLeadIds.has(a.lead_id)");
  });

  it("quotes the money promises from the canonical constants", () => {
    // Ghost protection and the first-application credit are two different
    // promises (src/lib/guaranteeCopy.ts); wording that drifts is a legal
    // problem, so both are rendered verbatim from there.
    expect(page).toContain("GHOST_PROTECTION_GUARANTEE");
    expect(page).toContain("FIRST_APPLICATION_GUARANTEE");
    expect(page).toContain("CREDIT_NOT_CASH_LINE");
  });

  it("opens one with ?application=, which also hides the list on a phone", () => {
    expect(page).toContain("searchParams.lead || searchParams.application");
    expect(view).toContain("/pro/chats?application=${row.id}");
  });

  it("gives the application pane no composer", () => {
    // A pro cannot message a homeowner who has not picked them. The pane says
    // so in words instead of showing a dead input.
    const pane = view.slice(view.indexOf("selectedApplication ? ("));
    expect(pane).not.toContain("<input");
    expect(pane).not.toContain("<textarea");
    expect(pane).toContain("You cannot message this homeowner yet.");
  });
});

describe("pro Messages: unread pill on a phone", () => {
  // CEO pass D3: the "New" pill carries meaning (unread), so on a phone it
  // steps up to 14px instead of the old 12px. Desktop (base text-[10px]) is
  // unchanged.
  it("is 14px on a phone, 10px above sm", () => {
    expect(view).toContain(
      'text-[10px] font-semibold uppercase tracking-wide text-white max-sm:text-sm'
    );
    expect(view).not.toContain(
      'text-[10px] font-semibold uppercase tracking-wide text-white max-sm:text-xs'
    );
  });
});

// The regression this half of the file exists for. See the long comment at the
// top of ChatsView.tsx: as server markup, the conversation list sat past the
// point where React Flight starts deferring elements into rows of their own,
// and on a pro with eight real conversations the page's Flight row carried
// eight deferrals - six list rows plus the thread pane. Each of those becomes
// an out-of-order SSR segment (a `<template id="P:n">` hole inside the page's
// own markup plus a late `$RS(...)` fill script) whenever the row is still
// unresolved as Fizz walks past it, which is the shape that accompanies the
// React #418 hydration failure on the pro pages.
//
// A unit test cannot see a stream, so these assert the properties that keep
// the stream shape: the whole body is one client module, and the page hands it
// plain data rather than rendering the list itself.
describe("pro Messages stays one client component with plain-data props", () => {
  it("ChatsView carries the \"use client\" directive", () => {
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = view
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("leaves no list or thread markup in the server page", () => {
    // The tail of the page's Flight row is what gets chopped, so the page must
    // end at the single <ChatsView> element. Any <ul>/<li>/<AskHearthRow> back
    // in here would put elements after ChatsView's ~4 kB of props, past the
    // budget, and the deferrals would return.
    expect(page).toContain("<ChatsView");
    for (const tag of ["<ul", "<li", "<AskHearthRow", "<LeadChat", "<PhoneChatFrame"]) {
      expect(page).not.toContain(tag);
    }
  });

  it("passes the rows as resolved strings, not elements or functions", () => {
    // Every field of a row is a string or a boolean computed on the server.
    // A ReactNode or a bare closure in here would be an element to defer (or
    // an unserializable prop) all over again.
    expect(page).toContain("const rows: ChatRow[] = convos.map((l) => {");
    const rowsBlock = page.slice(
      page.indexOf("const rows: ChatRow[]"),
      page.indexOf("  return (")
    );
    expect(rowsBlock).not.toMatch(/<[A-Za-z]/);
  });

  it("keeps the thread pane in the same client component as the list", () => {
    // Both branches, or neither: a server-rendered thread pane would sit after
    // the list's props and be deferred on its own.
    expect(view).toContain("<LeadChat");
    expect(view).toContain("Select a conversation");
  });
});

// The same check against a real streamed response. It needs a running server
// and a signed-in pro cookie, so it is opt-in. Point it at a pro with at least
// a couple of conversations, and give it one lead id so the thread branch is
// covered too:
//
//   HEARTH_CHATS_STREAM_URL=http://localhost:3104 \
//   HEARTH_CHATS_STREAM_LEAD=<lead uuid> \
//   HEARTH_CHATS_STREAM_COOKIE='sb-...' npx vitest run src/app/pro/chats/page.test.ts
const streamBase = process.env.HEARTH_CHATS_STREAM_URL;
const streamLead = process.env.HEARTH_CHATS_STREAM_LEAD;

describe.skipIf(!streamBase)("served /pro/chats has no deferred rows or nested holes", () => {
  async function get(path: string) {
    const res = await fetch(streamBase + path, {
      headers: { cookie: process.env.HEARTH_CHATS_STREAM_COOKIE ?? "" },
    });
    const html = await res.text();
    return { res, html };
  }

  // Row "6" is the page's own Flight row under the pro layout; rows 0/3 and
  // the low hex ids belong to the Next.js shell and defer on every route,
  // fixed or not, so this asserts on the page row rather than the total.
  const PAGE_ROW = "6";

  it("list branch: page row is emitted whole", async () => {
    const { res, html } = await get("/pro/chats");
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });

  it.skipIf(!streamLead)("thread branch: page row is emitted whole", async () => {
    const { res, html } = await get(`/pro/chats?lead=${streamLead}`);
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });
});
