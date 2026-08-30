import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-shape guards for the pro shell.
//
// These are not style rules. The pro shell is the one shell in the app that
// ever put a <Suspense> boundary in the MIDDLE of its own markup (around
// AppGuideMount), and that boundary was the cause of the intermittent
// `Minified React error #418` plus
// `Cannot read properties of null (reading 'parentNode') at $RS` that only
// ever showed on /pro pages. A mid-shell boundary streams as
// `<!--$?--><template id="B:n"></template><!--/$-->` and React's own reveal
// script rewrites those three nodes in place when the server resolves it; on a
// pro page the shell flushes long before that read finishes, so the rewrite
// lands in the few milliseconds the browser spends hydrating the shell around
// it. When it does, React loses its place in the child list of the shell's
// root <div>, throws the host-element mismatch at <main>, client-renders the
// whole root, and the page-content fill script that runs afterwards finds no
// <template> left to insert before - which is the $RS TypeError.
//
// The homeowner shell (src/app/(app)/layout.tsx) has always mounted the same
// component with no boundary, by awaiting getUserProfile() at the top so the
// read inside AppGuideMount is a per-request cache hit. The pro shell does the
// same now, and these tests are here so it stays that way.
const layoutSource = readFileSync(
  join(process.cwd(), "src/app/pro/layout.tsx"),
  "utf8"
);

const homeLayoutSource = readFileSync(
  join(process.cwd(), "src/app/(app)/layout.tsx"),
  "utf8"
);

// The comments in these files talk about the boundary at length, on purpose -
// the reasoning is the point. So the code checks below run against a copy with
// every comment removed, or they would fail on their own explanation.
function withoutComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const layoutCode = withoutComments(layoutSource);
const homeLayoutCode = withoutComments(homeLayoutSource);

describe("pro shell layout", () => {
  it("mounts the first-run guide with no Suspense boundary around it", () => {
    expect(layoutCode).toContain("<AppGuideMount side=\"pro\" />");
    expect(layoutCode).not.toMatch(/<Suspense[\s>]/);
    expect(layoutCode).not.toMatch(/^import .*\bSuspense\b.* from "react";$/m);
  });

  it("warms the profile read the guide needs, in the shell's existing Promise.all", () => {
    // Without this the bare mount above would add a fresh database round trip
    // to the shell's critical path; with it the read inside AppGuideMount is a
    // React cache() hit and the shell waits on nothing new.
    const promiseAll = layoutCode.match(/await Promise\.all\(\[[\s\S]*?\]\)/);
    expect(promiseAll).not.toBeNull();
    expect(promiseAll![0]).toContain("getUserProfile()");
  });

  it("never lets that warm-up read take the whole shell down", () => {
    // getUserProfile() can throw on a database that has not had migration 0137
    // applied. AppGuideMount swallows that itself; an unguarded await up in the
    // layout would turn it into a 500 for every pro page.
    expect(layoutCode).toMatch(/getUserProfile\(\)\.catch\(\(\) => null\)/);
  });

  it("matches the homeowner shell, which mounts the same component bare", () => {
    expect(homeLayoutCode).toContain("<AppGuideMount side=\"homeowner\" />");
    expect(homeLayoutCode).not.toMatch(/<Suspense[\s\S]{0,120}AppGuideMount/);
  });
});

// The header's "Back office" button (ProNav.tsx) needs one precomputed href:
// /pro/tools when the pro can use it, /pro/plus?reason=tools otherwise. The
// gating rule (member, or established with drafts left) belongs to the shell,
// which already loads the contractor for this request - not to ProNav, which
// stays a dumb prop-in prop-out component. Source-level, like the tests
// above: rendering the async layout needs a Supabase-backed contractor.
describe("pro shell back-office href", () => {
  it("computes backOfficeHref from the same helpers /pro/tools itself gates on", () => {
    expect(layoutCode).toContain(
      'import { getCurrentContractor, getSides, isEstablishedPro } from "@/lib/contractor"'
    );
    expect(layoutCode).toContain('import { hasProPlan } from "@/lib/subscription"');
    expect(layoutCode).toContain('import { proDraftsLeft } from "@/lib/freeAiTasteServer"');
    expect(layoutCode).toContain("const member = await hasProPlan();");
    // The two reads after the membership check run as one wave (speed wave
    // P2, 2026-08-30); the gate itself is unchanged: established still
    // decides whether the drafts counter counts.
    expect(layoutCode).toContain(
      "member ? Promise.resolve(true) : isEstablishedPro(contractor.id),"
    );
    expect(layoutCode).toContain("proDraftsLeft(contractor.id, member),");
    expect(layoutCode).toContain("const established = member || establishedRead;");
    expect(layoutCode).toContain("const draftsLeft = established ? draftsRead : null;");
  });

  it("picks /pro/tools when usable and the buy page otherwise, and passes it to ProNav", () => {
    expect(layoutCode).toContain(
      'const backOfficeHref = canUseBackOffice ? "/pro/tools" : "/pro/plus?reason=tools";'
    );
    expect(layoutCode).toContain("backOfficeHref={backOfficeHref}");
  });
});
