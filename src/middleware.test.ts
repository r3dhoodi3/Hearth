import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// src/middleware.ts now wires up Global Privacy Control (src/lib/gpc.ts),
// which pulls in src/lib/trackServer.ts -> src/lib/supabase/admin.ts, and
// that file imports "server-only" to fail the build if it is ever bundled
// into client code. The package is not resolvable outside a Next build (it
// isn't even in node_modules - Next provides it), so importing "@/middleware"
// here throws unless it's mocked, same pattern as every other test that
// transitively reaches a server-only module.
vi.mock("server-only", () => ({}));

// updateSession() reaches Supabase's auth server (createServerClient +
// getUser()); replaced with a stub that behaves like a signed-out pass
// through, real @/lib/supabase/middleware.isGuardedPath/isPublicPath are kept
// intact for the matcher tests below.
vi.mock("@/lib/supabase/middleware", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supabase/middleware")>();
  return {
    ...actual,
    updateSession: vi.fn(async (request: NextRequest) =>
      NextResponse.next({ request })
    ),
  };
});

const logGpcSignalOncePerSession = vi.fn(
  async (
    _headers: Headers,
    _requestCookies: Pick<import("@/lib/gpc").GpcCookieJar, "get">,
    _cookies: Pick<import("@/lib/gpc").GpcCookieJar, "set">,
    _userId: string | null
  ): Promise<void> => {}
);
vi.mock("@/lib/gpc", () => ({
  logGpcSignalOncePerSession: (...args: Parameters<typeof logGpcSignalOncePerSession>) =>
    logGpcSignalOncePerSession(...args),
}));

import { config, middleware } from "@/middleware";
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

// Global Privacy Control wiring (src/lib/gpc.ts). updateSession and
// logGpcSignalOncePerSession are both mocked above so this only asserts the
// wiring itself: the helper is called with this request's headers and this
// response's cookies, the DB write it triggers rides on event.waitUntil
// rather than blocking the response, and a throw from the helper never takes
// the request down with it.
describe("Global Privacy Control wiring", () => {
  beforeEach(() => {
    logGpcSignalOncePerSession.mockClear();
  });

  function fakeEvent() {
    const waited: Promise<unknown>[] = [];
    const event = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    };
    return { event: event as unknown as Parameters<typeof middleware>[1], waited };
  }

  it("calls the GPC helper with this request's headers and the final response's cookies, without awaiting it", async () => {
    const { event, waited } = fakeEvent();
    const request = new NextRequest("https://example.com/dashboard", {
      headers: { "Sec-GPC": "1" },
    });

    const response = await middleware(request, event);

    expect(logGpcSignalOncePerSession).toHaveBeenCalledTimes(1);
    const [headersArg, requestCookiesArg, cookiesArg, userIdArg] =
      logGpcSignalOncePerSession.mock.calls[0];
    expect(headersArg.get("sec-gpc")).toBe("1");
    // Same jar the response that was returned carries, so a cookie the helper
    // sets is not lost.
    expect(cookiesArg).toBe(response.cookies);
    // The once-per-session marker is READ from what the browser sent.
    expect(requestCookiesArg).toBe(request.cookies);
    expect(userIdArg).toBeNull();
    // Non-blocking: the returned promise is handed to event.waitUntil, not
    // awaited inline by the middleware.
    expect(waited).toHaveLength(1);
  });

  it("never lets a throwing GPC helper break the response", async () => {
    logGpcSignalOncePerSession.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { event } = fakeEvent();
    const request = new NextRequest("https://example.com/dashboard");

    await expect(middleware(request, event)).resolves.toBeInstanceOf(
      NextResponse
    );
  });

  it("never lets a rejecting GPC helper surface as an unhandled rejection", async () => {
    logGpcSignalOncePerSession.mockRejectedValueOnce(new Error("boom"));
    const { event, waited } = fakeEvent();
    const request = new NextRequest("https://example.com/dashboard");

    await middleware(request, event);
    expect(waited).toHaveLength(1);
    // The middleware's own .catch(() => {}) is what makes this safe to await
    // directly here instead of needing a try/catch.
    await expect(waited[0]).resolves.toBeUndefined();
  });
});
