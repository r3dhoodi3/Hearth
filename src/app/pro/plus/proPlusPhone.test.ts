import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// /pro/plus after the 2026-08-29 pass: the same phone treatment worker D gave
// the homeowner /plus page, plus the ?reason= banners the homeowner page has
// had for a while.
//
// Source assertions, in a node environment: both files are server/client
// components whose branches need a live subscription row and a Stripe action to
// render, and what is being checked here is a set of structural rules
// (breakpoint gating, text sizes, banner keys) that read cleanly off the source.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const page = src("./page.tsx");
const toggle = src("./ProPlanToggle.tsx");
const homeownerToggle = src("../../(app)/plus/PlanToggle.tsx");
const perksList = src("./PerksList.tsx");

describe("pro plus: the phone disclosure, matching the homeowner page", () => {
  it("folds the itemized terms behind a 'Billing terms' details on phones only", () => {
    // Two elements, one per breakpoint: `open` is a boolean attribute no media
    // query can drive.
    expect(toggle).toContain('<details className="group sm:hidden">');
    expect(toggle).toContain("Billing terms");
    expect(toggle).toContain('<div className="max-sm:hidden">');
    // Same shape the homeowner page uses.
    expect(homeownerToggle).toContain("Billing terms");
  });

  it("renders the disclosure twice per checkout form, so desktop is unchanged", () => {
    // Three AutoRenewalTerms per form pair: the trial form's two, plus the
    // picker form's two. Four in total across the file.
    const count = (toggle.match(/<AutoRenewalTerms/g) ?? []).length;
    expect(count).toBe(4);
  });

  it("keeps a one-line material summary visible on the phone, never folded", () => {
    // ROSCA 15 U.S.C. 8403(1) and Cal. Bus. and Prof. Code 17602(a)(1) want
    // material terms in visual proximity to consent. What folds is the
    // itemized copy, never this line.
    expect(toggle).toContain("function planBilling(plan: Plan, trialEligible: boolean)");
    expect(toggle).toContain("{planBilling(plan, trialEligible)}");
    expect(toggle).toContain(
      '<p className="text-sm text-stone-600 sm:hidden dark:text-stone-300">'
    );
  });

  it("quotes every number from PRO_PLAN rather than typing one in", () => {
    expect(toggle).toContain("${PRO_PLAN.trialDays} days free");
    expect(toggle).toContain("${PLAN_COPY.monthly.price}");
    expect(toggle).toContain("${PLAN_COPY.yearly.price}");
  });
});

describe("pro plus: phone text sizes", () => {
  it("lifts every 10px and 11px line above the readable floor on phones", () => {
    // Every text-[10px] / text-[11px] in this file must carry a max-sm:
    // override. Desktop keeps the original class, so sm and up is unchanged.
    const smalls = [...toggle.matchAll(/className="[^"]*text-\[1[01]px\][^"]*"/g)];
    expect(smalls.length).toBeGreaterThan(0);
    for (const m of smalls) {
      expect(m[0], m[0]).toMatch(/max-sm:text-(xs|sm)/);
    }
  });

  it("lifts the 12px card lines to 14px on phones only", () => {
    const xs = [...toggle.matchAll(/className="[^"]*\btext-xs\b[^"]*"/g)];
    for (const m of xs) {
      // A text-xs that is already inside a max-sm: override is fine; a bare
      // one on a card line is not.
      expect(m[0], m[0]).toMatch(/max-sm:text-sm|max-sm:text-xs/);
    }
  });

  it("changes nothing at sm and up: every phone rule is a max-sm variant", () => {
    // If a size rule ever lands without a breakpoint prefix it silently
    // rewrites the desktop page, which the owner's rule forbids.
    expect(toggle).not.toContain('className="text-sm font-medium text-stone-700 max-sm:');
  });
});

// CEO pass item B (2026-08-30): the pitch branch used to read hero -> "never
// changes" banner -> six perk cards -> the trial button, so the offer sat
// below a screen or two of preamble on a phone. flex+order reorders the SAME
// children per breakpoint (a duplicate ProPlanToggle would double its forms
// and radio group), so what proves the reorder from source is the pairing of
// max-sm:order-N with sm:order-N on each moved child, not a rendered tree.
describe("pro plus: phone leads with the offer, not the perks (CEO pass item B)", () => {
  it("swaps space-y for flex+gap so children can reorder without duplicating ProPlanToggle", () => {
    expect(page).toContain(
      '<div className="mx-auto flex max-w-3xl flex-col gap-8">'
    );
    // Exactly one ProPlanToggle in this branch - the reorder is a CSS order
    // change, never a second copy of the form.
    expect(page.match(/<ProPlanToggle trialEligible={trialEligible} \/>/g)?.length).toBe(1);
  });

  it("puts the offer directly under the H1 in the markup, with sm:order-6 restoring its old visual spot on desktop", () => {
    expect(page).toContain('<div className="max-sm:order-3 sm:order-6">');
    const h1 = page.indexOf("Run your business, not your admin");
    const offer = page.indexOf('<div className="max-sm:order-3 sm:order-6">');
    const perks = page.indexOf('<div className="max-sm:order-6 sm:order-4">');
    expect(h1).toBeGreaterThan(-1);
    // Markup order is the phone order: the offer now sits right after the H1,
    // ahead of the banner and the perks that used to precede it in the JSX.
    // CSS order (sm:order-6, greater than the perks' sm:order-4) is what puts
    // it back below the perks visually on desktop, without moving it in the
    // markup a second time.
    expect(offer).toBeGreaterThan(h1);
    expect(offer).toBeLessThan(perks);
  });

  it("shrinks the never-changes banner to one line on a phone, keeps the full sentence on desktop", () => {
    expect(page).toContain(
      "max-sm:order-4 max-sm:p-2 max-sm:text-xs sm:order-3 sm:p-4 sm:text-sm"
    );
    expect(page).toContain('<span className="sm:hidden">');
    expect(page).toContain('<span className="hidden sm:inline">');
    // The phone span drops the reinforcing second sentence; the desktop span
    // keeps both, word for word as before.
    expect(page).toContain("stays open to every pro, pay per application, member or not.");
  });

  it("puts the perk cards after the offer on a phone, back in their old spot on desktop", () => {
    expect(page).toContain('<div className="max-sm:order-6 sm:order-4">');
  });
});

// The regression this block exists for: DBG3 (scratchpad/debug-DBG3.md) found
// /pro throwing React #418 plus a chain of "$RS ... parentNode" failures
// because a stateless Server Component (SetupChecklist) rendered a list of
// items at the tail of the page's Flight row, past the point where React
// starts deferring elements it meets once a row passes a 3200-byte budget -
// each deferral becomes its own out-of-order stream segment, seen in the
// served HTML as a <template id="P:n"> hole nested inside the page's own
// markup instead of the one top-level hole a healthy page has. The live
// post-push check found the same #418 / "$RS" shape on /pro/plus, and PERKS
// (six description-heavy items) was the same kind of inline list sitting near
// the tail of all three of this page's render branches. Same fix: PerksList
// is a client module, so the whole block collapses to one client reference
// with plain-data props instead of many server elements for Flight to defer.
describe("pro plus: perks no longer sit at the tail as inline server elements (DBG3)", () => {
  it("renders PERKS through the client PerksList component in every branch", () => {
    expect(page).toContain('import PerksList from "./PerksList";');
    // PERKS_CARD / PERKS_LIST still build with PERKS.map (plain objects, not
    // JSX); what must be gone is a render branch mapping PERKS into JSX
    // inline. jsx-a11y/no-danger aside, the reliable signal is that no branch
    // still opens a <li> or <div> per perk directly in this file.
    expect(page).not.toContain("{PERKS.map((p) => (");
    // All three render branches (welcome, member, pitch) use it.
    expect(page).toContain('<PerksList perks={PERKS_LIST} variant="welcome" />');
    expect(page).toContain('<PerksList perks={PERKS_LIST} variant="member" />');
    expect(page).toContain('<PerksList perks={PERKS_CARD} variant="grid" />');
  });

  it("keeps PerksList a client module with plain-data props, no raw icon references", () => {
    const firstStatement = perksList
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))[0];
    expect(firstStatement).toBe('"use client";');
    // The icon crosses the boundary pre-rendered (a ReactNode leaf), never as
    // a bare LucideIcon function reference - that would fail to serialize.
    expect(page).toContain("icon: <p.icon");
    expect(perksList).not.toContain("import type { LucideIcon }");
  });

  it("preserves every class the three original inline blocks used", () => {
    // Card layout (the pitch page).
    expect(perksList).toContain('className="card"');
    expect(perksList).toContain('className="icon-chip"');
    expect(perksList).toContain(
      'className="mt-2 font-semibold text-stone-900 dark:text-stone-100"'
    );
    // Bullet layout, both flavors (welcome's centered <ul>, member's plain one).
    expect(perksList).toContain('"mx-auto max-w-md space-y-2 text-left"');
    expect(perksList).toContain('"space-y-2"');
    expect(perksList).toContain(
      'className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"'
    );
    expect(perksList).toContain(
      'className="mt-0.5 font-bold text-green-600 dark:text-green-400"'
    );
  });
});

// The served-HTML shape check DBG3 wrote (src/components/pro/SetupChecklist.test.tsx),
// copied rather than imported: importing straight from another *.test.tsx file
// re-runs ITS describe/it blocks as a side effect of the import (vitest loaded
// them here too, and several failed for lacking that file's own jsdom
// environment pragma) - not worth it for one 30-line pure function. Keep the
// two in sync by eye if either changes.
function nestedStreamHoles(html: string): string[] {
  const VOID = new Set(
    "area base br col embed hr img input link meta param source track wbr".split(" ")
  );
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack: { tag: string; attrs: string }[] = [];
  const nested: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClosing = m[4] === "/";
    if (!closing && tag === "template") {
      const id = (attrs.match(/id="([^"]*)"/) ?? [])[1] ?? "";
      const parent = stack[stack.length - 1];
      if (id.startsWith("P:") && !(parent && /id="S:[0-9a-f]+"/.test(parent.attrs))) {
        nested.push(id);
      }
    }
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (!selfClosing && !VOID.has(tag)) {
      stack.push({ tag, attrs });
    }
  }
  return nested;
}

describe("nestedStreamHoles (copy of the SetupChecklist.test.tsx helper)", () => {
  it("accepts the healthy shape and flags a hole nested inside the page's own markup", () => {
    const healthy =
      '<body><main><!--$?--><template id="B:0"></template></main>' +
      '<div hidden id="S:0"><template id="P:2"></template></div></body>';
    expect(nestedStreamHoles(healthy)).toEqual([]);

    const broken =
      '<body><div hidden id="S:2"><section class="grid"><div class="card">' +
      '<template id="P:3"></template></div><template id="P:5"></template>' +
      '</section></div></body>';
    expect(nestedStreamHoles(broken)).toEqual(["P:3", "P:5"]);
  });
});

// The same check against a real streamed response. Opt-in, same rule as the
// SetupChecklist version: it needs a running server and a signed-in pro
// cookie, so it stays skipped in the normal offline-green run.
//
//   HEARTH_STREAM_CHECK_URL=http://localhost:3103/pro/plus \
//   HEARTH_STREAM_CHECK_COOKIE='sb-...' npx vitest run src/app/pro/plus/proPlusPhone.test.ts
const plusStreamUrl = process.env.HEARTH_STREAM_CHECK_URL;
describe.skipIf(!plusStreamUrl)("served /pro/plus HTML has no nested stream holes", () => {
  it("keeps every <template id=\"P:\"> a direct child of a hidden segment", async () => {
    const res = await fetch(plusStreamUrl as string, {
      headers: { cookie: process.env.HEARTH_STREAM_CHECK_COOKIE ?? "" },
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(nestedStreamHoles(html)).toEqual([]);
  });
});

describe("pro plus: ?reason= banners", () => {
  it("maps each door to its own pitch", () => {
    expect(page).toContain("const REASON_COPY: Record<string, string> = {");
    for (const key of ["tools:", "ask:", "leads:", "nudge:", "feedback:", "logo:"]) {
      expect(page, key).toContain(key);
    }
  });

  it("renders nothing for an unknown or absent reason", () => {
    expect(page).toContain('REASON_COPY[searchParams.reason ?? ""] ?? null');
    expect(page).toContain("{reasonCopy && (");
  });

  it("quotes the free-draft count from the constant, never a typed number", () => {
    expect(page).toContain("${FREE_PRO_DRAFTS} free drafts");
  });

  it("sends the buyer to the board after checkout, not back to a stale label", () => {
    expect(page).toContain("<Link href={PRO_LEADS_HREF} className=\"btn-primary\">");
    expect(page).toContain("Find jobs");
    // The old label survives only in the comment that records why it changed;
    // what must be gone is the hard-coded "/pro" primary button.
    expect(page).not.toContain('<Link href="/pro" className="btn-primary">');
  });
});
