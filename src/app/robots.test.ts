import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISALLOWED_PATHS } from "./robots";
import { isGuardedPath } from "@/lib/supabase/middleware";

// robots.txt used to name six of the app's private segments and leave the
// other twenty-odd open to crawlers. Nothing leaked, because middleware
// redirects them all, but the redirect targets carry a `next=` parameter and
// /join carries an invite token, and neither belongs in a search index.
//
// The two directions below are what keep the file honest without anyone having
// to remember it exists:
//   1. everything the middleware guards is disallowed,
//   2. nothing PUBLIC is disallowed by accident.
// Source-text on the middleware side, the same trick
// src/lib/ownershipChecks.test.ts and src/lib/supabase/guardedSegments.test.ts
// use, because GUARDED_SEGMENTS is module-private by design.

function guardedSegmentsFromSource(): string[] {
  const src = readFileSync(
    fileURLToPath(new URL("../lib/supabase/middleware.ts", import.meta.url)),
    "utf8"
  );
  const block = /const GUARDED_SEGMENTS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  if (!block) throw new Error("GUARDED_SEGMENTS literal was not found");
  return Array.from(block[1].matchAll(/"([a-z0-9-]+)"/g)).map((m) => m[1]);
}

describe("robots.txt", () => {
  it("finds the middleware's guarded segment list", () => {
    const segments = guardedSegmentsFromSource();
    expect(segments.length).toBeGreaterThan(20);
    expect(segments).toContain("dashboard");
  });

  it("disallows every segment the middleware guards", () => {
    for (const segment of guardedSegmentsFromSource()) {
      const covered = DISALLOWED_PATHS.some(
        (p) => p === `/${segment}` || p === `/${segment}/`
      );
      expect(covered, `/${segment} is private but crawlable`).toBe(true);
    }
  });

  it("disallows nothing that is actually public", () => {
    for (const path of DISALLOWED_PATHS) {
      expect(isGuardedPath(path.replace(/\/$/, "")), `${path} is public`).toBe(
        true
      );
    }
  });

  // The landing pages, city pages, guides and public pro profiles are the
  // whole point of having a sitemap; a stray prefix here would delist them.
  it("leaves the public marketing surface crawlable", () => {
    for (const publicPath of [
      "/",
      "/pros",
      "/pricing",
      "/p/some-pro-slug",
      "/guides/roof-maintenance",
      "/fountain-valley",
      "/privacy",
      "/terms",
      "/contact",
    ]) {
      const blocked = DISALLOWED_PATHS.some((p) => publicPath.startsWith(p));
      expect(blocked, `${publicPath} must stay crawlable`).toBe(false);
    }
  });
});
