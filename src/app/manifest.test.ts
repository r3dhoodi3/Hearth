import { describe, expect, it } from "vitest";
import manifest from "./manifest";
import { isPublicPath } from "@/lib/supabase/middleware";

// The manifest's start_url is what the installed app opens to, usually with
// no session on the very first request after a launch. Two things are pinned
// so they cannot drift apart:
//
//   1. It points at the static launch shell (/open), not the dashboard. The
//      shell exists because a serverless cold start plus the signed-out 307
//      left the installed app on a blank white screen; pointing start_url
//      back at a dynamic page would quietly reintroduce that.
//   2. Whatever it points at is public in the middleware. A guarded start_url
//      would bounce the very first paint to /signin before anything rendered,
//      which is the same blank-screen failure by another route.
describe("web app manifest", () => {
  it("launches the installed app into the static shell", () => {
    expect(manifest().start_url).toBe("/open?source=pwa");
  });

  it("keeps the launch URL public so the first paint needs no session", () => {
    const startUrl = manifest().start_url;
    expect(startUrl).toBeDefined();
    // isPublicPath takes a path, so strip the ?source=pwa attribution marker
    // the same way the middleware sees it (nextUrl.pathname has no query).
    const path = new URL(startUrl as string, "https://hearth.invalid").pathname;
    expect(isPublicPath(path)).toBe(true);
  });
});
