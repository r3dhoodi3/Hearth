import { describe, expect, it } from "vitest";
import { config } from "@/middleware";
import { isGuardedPath, isPublicPath } from "@/lib/supabase/middleware";

// The matcher decides which requests pay for a session refresh. It has to keep
// letting every real page through while skipping the files served straight out
// of /public, so it is worth pinning both halves down.
const matches = (path: string) =>
  config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

describe("middleware matcher", () => {
  it("runs on app pages and API routes", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/dashboard")).toBe(true);
    expect(matches("/pro")).toBe(true);
    expect(matches("/pro/billing?need=20.00")).toBe(true);
    expect(matches("/api/pro-ask")).toBe(true);
  });

  it("skips Next internals", () => {
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
  });

  it("skips everything served straight out of /public", () => {
    for (const asset of [
      "/demo-vo/hook.mp3",
      "/demo-vo/pro/leads.mp3",
      "/photos/plumber-pipe-fittings.jpg",
      "/photos/CREDITS.md",
      // public/sw.js, fetched by the browser on every service-worker update
      // check. There is nothing to guard and nothing to refresh on it.
      "/sw.js",
      // public/warming.html, the cold-start loading screen the service worker
      // precaches for every user. A /signin redirect here would be cached in
      // place of the screen, so it is excluded exactly like sw.js.
      "/warming.html",
    ]) {
      expect(matches(asset), asset).toBe(false);
    }
  });

  // The regression this matcher exists to prevent. The old rule ended in an
  // open-ended `.*\.(?:svg|png|...)$` alternation that tested the WHOLE path,
  // so a guarded route whose URL merely ended in an asset extension skipped
  // the middleware and never met the sign-in check. Both of these live behind
  // a session in the app.
  it("still runs on guarded routes whose URL ends in an asset extension", () => {
    for (const path of [
      "/pro/crm/2f1c0f5e-0a1b-4c2d-8e3f-9a0b1c2d3e4f.png",
      "/api/win-card/123.png",
      "/api/review-card/abc.svg",
      "/dashboard/report.xml",
      "/chats/attachment.webp",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });

  // Generated routes out of src/app that keep their own file-ish names. They
  // used to run the middleware and be answered anonymously by it; now they are
  // skipped by name, which is the same answer for one less invocation. Both
  // halves are asserted: the matcher no longer runs on them, AND the middleware
  // would still have let them through if it did - so if one of these names is
  // ever removed from the matcher, nothing about the response changes.
  it("skips the generated icon/metadata routes, which never needed a session", () => {
    for (const path of [
      "/icon.svg",
      "/icon-192.png",
      "/icon-512.png",
      "/manifest.webmanifest",
    ]) {
      expect(matches(path), path).toBe(false);
      // Not public by name, but not guarded either, so a GET would have fallen
      // through to the route rather than being bounced to /signin.
      expect(isGuardedPath(path), path).toBe(false);
    }
    for (const path of ["/apple-icon", "/opengraph-image", "/robots.txt", "/sitemap.xml"]) {
      expect(matches(path), path).toBe(false);
      expect(isPublicPath(path), path).toBe(true);
    }
  });

  // The exclusions are anchored at the start of the path, so a guarded route
  // cannot inherit one by ending in the same name. This is the same class of
  // mistake as the old extension alternation, one level subtler.
  it("does not let a lookalike path borrow an exclusion", () => {
    for (const path of [
      "/pro/sw.js",
      "/pro/warming.html",
      "/account/robots.txt",
      "/chats/icon.svg",
      "/api/photos/1",
      "/pro/apple-icon",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });
});

// A GET that is neither public nor under a guarded segment is let through so
// Next can render src/app/not-found.tsx. Before this, every typo'd URL turned
// into /signin?next=... and a visitor had to create an account to be shown a
// 404.
describe("unrouted paths fall through to the 404", () => {
  const fallsThrough = (path: string) =>
    !isPublicPath(path) && !isGuardedPath(path);

  it("lets an unknown path through instead of demanding a session", () => {
    for (const path of [
      "/some-missing-page",
      "/blog",
      "/blog/2026/whatever",
      "/pros/nope",
      "/p",
    ]) {
      expect(fallsThrough(path), path).toBe(true);
    }
  });

  it("still guards every signed-in section", () => {
    for (const path of [
      "/dashboard",
      "/account/notifications",
      "/chats/abc",
      "/documents",
      "/emergency",
      "/forecast",
      "/home-report",
      "/inspection",
      "/issues",
      "/learn",
      "/plus",
      "/profile",
      "/quote-check",
      "/search",
      "/taxes",
      "/value",
      "/walkthrough",
      "/contractors/browse",
      "/onboarding",
      "/welcome",
      "/pro",
      "/pro/billing",
      "/pro/leads/123",
      "/api/ask",
    ]) {
      expect(isPublicPath(path), path).toBe(false);
      expect(isGuardedPath(path), path).toBe(true);
    }
  });

  // The PWA launch shell is public by exact match only. The shell itself must
  // paint with no session (it is the manifest's start_url, and demanding auth
  // would recreate the cold-start blank screen it exists to fix), but the
  // entry is not a prefix, and the segment is on GUARDED_SEGMENTS, so a
  // future routed page under /open/ redirects to /signin rather than
  // rendering to a signed-out visitor. The dashboard the shell forwards to
  // still demands a session.
  it("keeps the PWA launch shell public, exact match only", () => {
    expect(isPublicPath("/open")).toBe(true);
    expect(isPublicPath("/open/anything")).toBe(false);
    expect(isGuardedPath("/open/anything")).toBe(true);
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isGuardedPath("/dashboard")).toBe(true);
  });

  it("keeps the public pages public", () => {
    for (const path of [
      "/",
      "/open",
      "/signin",
      "/pros",
      "/pricing",
      "/privacy",
      "/terms",
      "/emergency-help",
      "/p/some-pro",
      "/guides/water-heater",
      "/api/stripe/webhook",
    ]) {
      expect(isPublicPath(path), path).toBe(true);
    }
  });
});
