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
    expect(page).toContain("{greeting}");
    expect(page).not.toContain(">Your leads</h1>");
  });
});

describe("pro home: quick actions", () => {
  it("leads with Find jobs (primary) and Messages", () => {
    const find = page.indexOf("Find jobs");
    const messages = page.indexOf('href="/pro/chats"');
    expect(find).toBeGreaterThan(-1);
    expect(messages).toBeGreaterThan(find);
    expect(page).toContain("href={PRO_LEADS_HREF}");
    // Never a hard-coded "/pro/leads": the constant is the one place it flips.
    expect(page).not.toContain('href="/pro/leads"');
  });

  it("carries the same unread badge the Messages tab does", () => {
    // Same component, same source, so the two counts cannot disagree.
    expect(page).toContain('<LiveUnreadBadge role="contractor" />');
  });

  it("is two columns on a phone", () => {
    expect(page).toContain('className="grid grid-cols-2 gap-2 sm:gap-4"');
  });
});

describe("pro home: three tool tiles (E8)", () => {
  it("uses the homeowner dashboard's tile row, class for class", () => {
    // Copied deliberately: the two home screens should feel like one app.
    expect(dashboard).toContain('className="grid grid-cols-3 gap-2 sm:gap-4"');
    expect(page).toContain('className="grid grid-cols-3 gap-2 sm:gap-4"');
    expect(dashboard).toContain('className="card-link p-3 text-center"');
    expect(page).toContain('className="card-link p-3 text-center"');
    expect(page).toContain('<p className="icon-chip">');
  });

  it("points at the three pro tools that already exist", () => {
    expect(page).toContain('href: "/pro/tools"');
    expect(page).toContain('href: "/pro/business"');
    expect(page).toContain('href: "/pro/playbook"');
  });

  it("shortens the titles below sm so three fit at 390px", () => {
    expect(page).toContain('shortTitle: "Estimate"');
    expect(page).toContain('shortTitle: "Numbers"');
    expect(page).toContain("<span className=\"sm:hidden\">{t.shortTitle}</span>");
    expect(page).toContain(
      '<span className="hidden sm:inline">{t.title}</span>'
    );
  });

  it("chips the tiles honestly: 'Pro' only where the door is truly member-only", () => {
    // The insights trend on /pro/business is really member-only, so it keeps
    // the hearth-accent "Pro" chip. The playbook is free for every pro, so it
    // wears nothing: a chip on an open door is a lie.
    expect(page).toContain('{!member && t.chip === "pro" && (');
    expect(page).toContain('title: "Playbook"');
    const playbookBlock = page.slice(
      page.indexOf('href: "/pro/playbook"'),
      page.indexOf('href: "/pro/playbook"') + 300
    );
    expect(playbookBlock).toContain("chip: null");
    const businessBlock = page.slice(
      page.indexOf('href: "/pro/business"'),
      page.indexOf('href: "/pro/business"') + 300
    );
    expect(businessBlock).toContain('chip: "pro" as const');
  });

  it("swaps the Estimate tile's chip for a green 'Free to try' tag (0145: two free drafts, not member-only)", () => {
    // Every contractor gets two free drafts before /pro/tools gates, so the
    // hearth-accent "Pro" chip used to overstate the door. It reads
    // "Free to try" instead, in ProChip's tone="free" styling, and is static
    // rather than a live drafts-left count (see the comment beside it in
    // page.tsx for why a query was not worth adding to this render).
    const estimateBlock = page.slice(
      page.indexOf('href: "/pro/tools"'),
      page.indexOf('href: "/pro/tools"') + 300
    );
    expect(estimateBlock).toContain('chip: "free" as const');
    expect(page).toContain('{!member && t.chip === "free" && (');
    expect(page).toContain('<ProChip tone="free" label="Free to try" />');
  });
});

describe("pro home: the blocks below", () => {
  it("previews at most two direct requests and links to the rest", () => {
    expect(page).toContain("const DIRECT_PREVIEW = 2;");
    expect(page).toContain("directRequests.slice(0, DIRECT_PREVIEW)");
    expect(page).toContain("See all");
  });

  it("renders the SAME direct-request card the leads board does", () => {
    // One component, not a second copy that would drift.
    expect(page).toContain("<DirectRequestCard");
    expect(src("./leads/page.tsx")).toContain("<DirectRequestCard");
  });

  it("shows wallet, open jobs, active jobs, and win rate, each linked", () => {
    expect(page).toContain(">Wallet</p>");
    expect(page).toContain(">Open jobs</p>");
    expect(page).toContain(">Active jobs</p>");
    expect(page).toContain('"Win rate" : "Applications"');
    // Win rate needs a real sample before it means anything.
    expect(page).toContain("appliedCount >= 3");
  });

  it("reuses the Business page's own trend numbers, members only", () => {
    expect(page).toContain("buildProStats(apps, new Date())");
    expect(page).toContain("const stats = member ?");
    expect(page).toContain('href="/pro/business"');
  });

  it("keeps the setup checklist, built by the shared builder", () => {
    expect(page).toContain("buildSetupItems({");
    expect(page).toContain("<SetupChecklist items={setupItems} />");
  });

  it("hides the Latest block rather than inventing one", () => {
    expect(page).toContain("latestRows.length > 0 &&");
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
  });
});

describe("pro home: loading skeleton", () => {
  it("matches the page's own shape, not the old leads board's", () => {
    expect(loading).toContain('className="grid grid-cols-2 gap-2 sm:gap-4"');
    expect(loading).toContain('className="grid grid-cols-3 gap-2 sm:gap-4"');
    expect(loading).not.toContain("Your leads");
  });
});
