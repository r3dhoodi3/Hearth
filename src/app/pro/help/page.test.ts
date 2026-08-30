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
const view = src("./HelpView.tsx");

// The regression this file exists for. See the long comment at the top of
// HelpView.tsx: /pro/help was the worst offender left after the DBG3 pass -
// measured live on 2026-08-30 its Flight row carried FOUR deferrals, all past
// byte ~4060 (the "Blocked accounts" link, then the feedback card, the app
// guide card and the membership footnote). Each deferral becomes an
// out-of-order SSR segment - a `<template id="P:n">` hole inside the page's own
// markup plus a late `$RS(...)` fill script - which is the shape that
// accompanies the React #418 hydration failure on the pro pages.
describe("pro help is one client component with plain-data props", () => {
  it('HelpView carries the "use client" directive', () => {
    // Comments may precede a directive prologue; statements may not.
    const firstStatement = view
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
  });

  it("leaves no markup in the server page", () => {
    expect(page).toContain("<HelpView");
    for (const tag of ["<div", "<h1", "<h2", "<p ", "<table", "<Link", "<a "]) {
      expect(page, tag).not.toContain(tag);
    }
  });

  it("passes plain data: booleans and already-defaulted strings", () => {
    for (const prop of [
      "member={member}",
      "trialEligible={trialEligible}",
      "feedbackClaimed={feedbackClaimed}",
      "sent={sent}",
    ]) {
      expect(page, prop).toContain(prop);
    }
    // The two fallbacks (company name, contact email) are resolved on the
    // server, where the auth user is.
    expect(page).toContain("contractor.owner_name || contractor.name");
    expect(page).toContain("contractor.contact_email || user?.email");
  });
});

describe("pro help keeps the content it always had", () => {
  it("keeps the lead pricing table and its anchor, which /pro/billing links to", () => {
    expect(view).toContain('id="lead-pricing"');
    expect(view).toContain("How lead pricing works");
    expect(view).toContain("${LEAD_TIER_FEES.light}");
    expect(view).toContain("${LEAD_TIER_FEES.skilled}");
    expect(view).toContain("${LEAD_TIER_FEES.major}");
    expect(view).toContain("${MAJOR_INTRO_FEE}");
    // Every number comes from the constants module, never typed in.
    expect(view).not.toMatch(/\$\d+ *</);
  });

  it("keeps the support form, the bug bounty, safety, and the app guide", () => {
    expect(view).toContain('id="support-form"');
    expect(view).toContain("Found a bug?");
    expect(view).toContain("Report abuse or a safety concern");
    expect(view).toContain('href="/pro/blocks"');
    expect(view).toContain("<ShowAppGuideButton tone=\"pro\" />");
  });

  it("hides the feedback card once the credit is claimed", () => {
    expect(view).toContain("{!feedbackClaimed && (");
    expect(view).toContain("{FEEDBACK_CARD_TITLE}");
  });
});

// The same check against a real streamed response. It needs a running server
// and a signed-in pro cookie, so it is opt-in:
//
//   HEARTH_HELP_STREAM_URL=http://localhost:3106 \
//   HEARTH_HELP_STREAM_COOKIE='sb-...' npx vitest run src/app/pro/help/page.test.ts
const streamBase = process.env.HEARTH_HELP_STREAM_URL;

describe.skipIf(!streamBase)("served /pro/help has no deferred rows or nested holes", () => {
  // Row "6" is the page's own Flight row under the pro layout; rows 0/3 and
  // the low hex ids belong to the Next.js shell and defer on every route,
  // fixed or not, so this asserts on the page row rather than the total.
  const PAGE_ROW = "6";

  it("page row is emitted whole", async () => {
    const res = await fetch(streamBase + "/pro/help", {
      headers: { cookie: process.env.HEARTH_HELP_STREAM_COOKIE ?? "" },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
    expect(deferredRowRefs(html)[PAGE_ROW] ?? 0).toBe(0);
  });
});
