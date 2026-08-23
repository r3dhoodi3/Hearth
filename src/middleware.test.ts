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

  it("skips the two /public asset folders", () => {
    for (const asset of [
      "/demo-vo/hook.mp3",
      "/demo-vo/pro/leads.mp3",
      "/photos/plumber-pipe-fittings.jpg",
      "/photos/CREDITS.md",
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
  // now run the middleware, which is fine: each is either public by name or
  // falls through as an unrouted GET, so none of them 307s to /signin. The
  // curl checks in the PR that introduced this pin the live behavior; these
  // assertions pin the two halves the middleware itself decides.
  it("lets the generated icon/metadata routes answer without a session", () => {
    for (const path of [
      "/icon.svg",
      "/icon-192.png",
      "/icon-512.png",
      "/manifest.webmanifest",
    ]) {
      expect(matches(path), path).toBe(true);
      // Not public by name, but not guarded either, so a GET falls through to
      // the route instead of being bounced to /signin.
      expect(isGuardedPath(path), path).toBe(false);
    }
    for (const path of [
      "/apple-icon",
      "/opengraph-image",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(matches(path), path).toBe(true);
      expect(isPublicPath(path), path).toBe(true);
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

  it("keeps the public pages public", () => {
    for (const path of [
      "/",
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
