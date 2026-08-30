import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The pro HOME tab (2026-08-29): /pro stopped being the leads board and became
// the screen a pro lands on.
//
// page.tsx pulls in the service-role Supabase client at module scope (via
// getCurrentContractor -> createAdminClient), which imports "server-only" and
// throws the moment it is imported outside a real server component render. So,
// like src/app/pro/leads/page.test.tsx and src/lib/constants.test.ts, this
// reads the source instead of importing the module.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
// The whole body moved into this client component for streaming reasons (see
// the last describe in this file), so every markup assertion reads it now.
const view = src("./HomeView.tsx");
const loading = src("./loading.tsx");
const dashboard = src("../(app)/dashboard/page.tsx");

describe("pro home: greeting", () => {
  it("greets by name and says what is waiting, both computed", () => {
    expect(page).toContain("greetingForHour(new Date().getHours())");
    expect(page).toContain("homeSubtitle({");
    // The three counts the sentence is built from.
    expect(page).toContain("openJobs: open.length");
    expect(page).toContain("awaitingReply,");
    expect(page).toContain("directRequests: directRequests.length");
  });

  it("prefers the owner's first name over the company name", () => {
    expect(page).toContain("owner_name");
    expect(page).toContain(".split(/\\s+/)[0]");
  });

  it("never prints a slogan: the h1 is the greeting", () => {
    expect(view).toContain("{greeting}");
    expect(view).not.toContain(">Your leads</h1>");
  });
});

describe("pro home: quick actions", () => {
  it("leads with Find jobs (primary) and Messages", () => {
    const find = view.indexOf("Find jobs");
    const messages = view.indexOf('href="/pro/chats"');
    expect(find).toBeGreaterThan(-1);
    expect(messages).toBeGreaterThan(find);
    expect(view).toContain("href={PRO_LEADS_HREF}");
    // Never a hard-coded "/pro/leads": the constant is the one place it flips.
    expect(view).not.toContain('href="/pro/leads"');
  });

  it("carries the same unread badge the Messages tab does", () => {
    // Same component, same source, so the two counts cannot disagree.
    expect(view).toContain('<LiveUnreadBadge role="contractor" />');
  });

  it("is two columns on a phone", () => {
    expect(view).toContain('className="grid grid-cols-2 gap-2 sm:gap-4"');
  });
});

describe("pro home: three tool tiles (E8)", () => {
  it("uses the homeowner dashboard's tile row, class for class", () => {
    // Copied deliberately: the two home screens should feel like one app.
    expect(dashboard).toContain('className="grid grid-cols-3 gap-2 sm:gap-4"');
    expect(view).toContain('className="grid grid-cols-3 gap-2 sm:gap-4"');
    expect(dashboard).toContain('className="card-link p-3 text-center"');
    expect(view).toContain('className="card-link p-3 text-center"');
    expect(view).toContain('<p className="icon-chip">');
  });

  it("points at the three pro tools that already exist", () => {
    expect(view).toContain('href: "/pro/tools"');
    expect(view).toContain('href: "/pro/business"');
    expect(view).toContain('href: "/pro/playbook"');
  });

  it("shortens the titles below sm so three fit at 390px", () => {
    expect(view).toContain('shortTitle: "Estimate"');
    expect(view).toContain('shortTitle: "Numbers"');
    expect(view).toContain("<span className=\"sm:hidden\">{t.shortTitle}</span>");
    expect(view).toContain(
      '<span className="hidden sm:inline">{t.title}</span>'
    );
  });

  it("chips the tiles honestly: 'Pro' only where the door is truly member-only", () => {
    // The insights trend on /pro/business is really member-only, so it keeps
    // the hearth-accent "Pro" chip. The playbook is free for every pro, so it
    // wears nothing: a chip on an open door is a lie.
    expect(view).toContain('{!member && t.chip === "pro" && (');
    expect(view).toContain('title: "Playbook"');
    const playbookBlock = view.slice(
      view.indexOf('href: "/pro/playbook"'),
      view.indexOf('href: "/pro/playbook"') + 300
    );
    expect(playbookBlock).toContain("chip: null");
    const businessBlock = view.slice(
      view.indexOf('href: "/pro/business"'),
      view.indexOf('href: "/pro/business"') + 300
    );
    expect(businessBlock).toContain('chip: "pro" as const');
  });

  it("swaps the Estimate tile's chip for a green 'Free to try' tag (0145: two free drafts, not member-only)", () => {
    // Every contractor gets two free drafts before /pro/tools gates, so the
    // hearth-accent "Pro" chip used to overstate the door. It reads
    // "Free to try" instead, in ProChip's tone="free" styling, and is static
    // rather than a live drafts-left count (see the comment beside it in
    // HomeView.tsx for why a query was not worth adding to this render).
    const estimateBlock = view.slice(
      view.indexOf('href: "/pro/tools"'),
      view.indexOf('href: "/pro/tools"') + 300
    );
    expect(estimateBlock).toContain('chip: "free" as const');
    expect(view).toContain('{!member && t.chip === "free" && (');
    expect(view).toContain('<ProChip tone="free" label="Free to try" />');
  });
});

describe("pro home: the blocks below", () => {
  it("previews at most two direct requests and links to the rest", () => {
    expect(page).toContain("const DIRECT_PREVIEW = 2;");
    expect(page).toContain("directRequests.slice(0, DIRECT_PREVIEW)");
    expect(view).toContain("See all");
  });

  it("renders the SAME direct-request card the leads board does", () => {
    // One component, not a second copy that would drift. Both tabs render it
    // from a client component now (a streaming fix - see LeadsBoard.tsx and
    // HomeView.tsx), not from the page module itself.
    expect(view).toContain("<DirectRequestCard");
    expect(src("./leads/LeadsBoard.tsx")).toContain("<DirectRequestCard");
  });

  it("shows wallet, open jobs, active jobs, and win rate, each linked", () => {
    expect(view).toContain(">Wallet</p>");
    expect(view).toContain(">Open jobs</p>");
    expect(view).toContain(">Active jobs</p>");
    expect(view).toContain('"Win rate" : "Applications"');
    // Win rate needs a real sample before it means anything.
    expect(view).toContain("appliedCount >= 3");
  });

  it("reuses the Business page's own trend numbers, members only", () => {
    expect(page).toContain("buildProStats(apps, new Date())");
    expect(page).toContain("const stats = member ?");
    expect(view).toContain('href="/pro/business"');
  });

  it("keeps the setup checklist, built by the shared builder", () => {
    expect(page).toContain("buildSetupItems({");
    expect(view).toContain("<SetupChecklist items={setupItems} />");
  });

  it("hides the Latest block rather than inventing one", () => {
    expect(view).toContain("latestRows.length > 0 &&");
  });
});

describe("pro home: paywall concepts (E9)", () => {
  it("nudges only an established non-member, never a member", () => {
    expect(page).toContain("const showNudge = !member && established;");
  });

  it("offers the feedback credit and retries the grant once they qualify", () => {
    expect(page).toContain("readFeedbackState(");
    expect(page).toContain(
      "if (feedback.sent && !feedback.claimed && established) {"
    );
    expect(page).toContain("grantFeedbackCredit(contractor.id)");
  });

  it("never says 'rating' next to the credit", () => {
    // App Store 1.1.7 / 3.2.2 and Play policy forbid paying for ratings; this
    // pays for a private product note and must never read as the other thing.
    expect(page.toLowerCase()).not.toContain("rating");
    expect(view.toLowerCase()).not.toContain("rating");
  });
});

describe("pro home: loading skeleton", () => {
  it("matches the page's own shape, not the old leads board's", () => {
    expect(loading).toContain('className="grid grid-cols-2 gap-2 sm:gap-4"');
    expect(loading).toContain('className="grid grid-cols-3 gap-2 sm:gap-4"');
    expect(loading).not.toContain("Your leads");
  });
});

// The rest of the DBG3 regression. Making SetupChecklist a client component
// took the served /pro from eight nested <template id="P:n"> holes to one, but
// it did not take the page row's DEFERRALS to zero: measured live on
// 2026-08-30 the row still cut the entire two-column lower half of the page
// into a row of its own, because the greeting and the two tile rows above it
// had already spent React Flight's 3200-byte budget. A unit test cannot see a
// stream, so these assert the properties that keep the shape.
describe("pro home renders one client element (DBG3 follow-up)", () => {
  it('HomeView carries the "use client" directive', () => {
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = view
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("leaves no markup in the server page", () => {
    expect(page).toContain("<HomeView");
    for (const tag of ["<div", "<section", "<h1", "<h2", "<p ", "<ul", "<Link"]) {
      expect(page, tag).not.toContain(tag);
    }
  });

  it("resolves the clock-dependent strings on the server", () => {
    // The greeting reads the hour and each direct request's posted-ago line
    // reads the clock; both stay in the page so SSR and hydration agree.
    expect(page).toContain("greetingForHour(new Date().getHours())");
    expect(page).toContain("postedAgo(d.created_at)");
    expect(view).not.toContain("new Date(");
    expect(view).not.toContain("postedAgo(");
  });
});
