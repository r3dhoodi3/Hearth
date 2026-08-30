import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every Supabase Realtime subscription in the app must name a `filter`.
//
// Without one the client asks the realtime server for the whole table and
// leans on RLS alone to trim the stream down to rows this user may see. RLS
// does hold (that part was checked in the 2026-08-29 audit), but it is the
// last line rather than the first: an unfiltered subscription ships every
// row of the table into the server-side RLS check for every subscriber, and
// one policy mistake turns into a live feed of other people's data. A filter
// means the server never considers a row that is not this user's to begin
// with.
//
// This is a source-level assertion, like phoneTapTargets.test.ts, because the
// components that subscribe all construct a live Supabase client and have no
// render harness of their own.

// The two subscriptions in src/app/pro/LeadsRealtime.tsx that used to be
// exempt here now carry a filter too: contractor_leads INSERT is scoped to
// status=eq.new (the value open_jobs_for_me() itself filters an unassigned
// job on), and lead_applications INSERT is scoped to this pro's own
// contractor_id. No exemptions remain - every subscription in src must carry
// a filter, full stop.
const KNOWN_UNFILTERED: Record<string, number> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Each `.on("postgres_changes", { ... }, handler)` config object, as source
// text. Counting braces rather than regex-matching the whole call keeps this
// honest about nested objects.
function subscriptionConfigs(src: string): string[] {
  const configs: string[] = [];
  const marker = '"postgres_changes"';
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    const open = src.indexOf("{", from);
    if (open === -1) break;
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === "{") depth++;
      else if (src[close] === "}" && --depth === 0) break;
    }
    configs.push(src.slice(open, close + 1));
  }
  return configs;
}

describe("realtime subscriptions are filtered server-side", () => {
  const files = walk("src");

  it("finds the subscriptions at all (guards against a broken scanner)", () => {
    const total = files.reduce(
      (n, f) => n + subscriptionConfigs(readFileSync(f, "utf8")).length,
      0
    );
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it("every postgres_changes subscription carries a filter", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.split(/[\\/]/).join("/");
      const unfiltered = subscriptionConfigs(readFileSync(file, "utf8")).filter(
        (config) => !/\bfilter\s*:/.test(config)
      ).length;
      const allowed = KNOWN_UNFILTERED[rel] ?? 0;
      if (unfiltered !== allowed) {
        offenders.push(`${rel}: ${unfiltered} unfiltered, expected ${allowed}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("LeadsRealtime's open-board contractor_leads and lead_applications subscriptions carry the expected filters", () => {
    // Two configs match table: "contractor_leads" (the pro's own leads, and
    // the open board), so this scopes to the INSERT one specifically -
    // event: "*" is the pro's-own-leads subscription, already filtered on
    // contractor_id and not what this test is pinning.
    const src = readFileSync("src/app/pro/LeadsRealtime.tsx", "utf8");
    const configs = subscriptionConfigs(src);
    const openBoardConfig = configs.find(
      (c) => c.includes("contractor_leads") && c.includes('event: "INSERT"')
    );
    const appsConfig = configs.find((c) => c.includes("lead_applications"));
    expect(openBoardConfig).toContain('filter: "status=eq.new"');
    expect(appsConfig).toContain("filter: `contractor_id=eq.${contractorId}`");
  });
});
