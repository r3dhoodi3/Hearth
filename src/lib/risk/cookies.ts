// The two first-party cookies the trial-abuse score reads, and the middleware
// helper that plants the device one.
//
// EDGE SAFE ON PURPOSE. This module is imported by src/middleware.ts, which runs
// on the Edge runtime, so it must not import node:crypto, the Supabase admin
// client, "server-only", or anything else from src/lib/risk. crypto.randomUUID
// is available on the Edge runtime's global Web Crypto.

import type { NextRequest, NextResponse } from "next/server";

// The device id. A random uuid, first-party, httpOnly, planted once and then
// left alone for 400 days (the ceiling Chrome will honour for a Set-Cookie
// expiry).
//
// IT IS USED FOR EXACTLY ONE THING: telling whether several Hearth accounts
// have been created or paid for from the same browser. It is not an analytics
// id, it is not joined to page views, it is never sent anywhere, and nothing
// outside src/lib/risk reads it. httpOnly means page scripts cannot read it
// either, so it cannot become a tracking handle by accident later.
export const DEVICE_COOKIE = "hearth_did";

// The browser fingerprint hash, written by src/components/DeviceFingerprint.tsx
// on the sign-up and sign-in pages. Not httpOnly, because the script that
// computes it is the thing that writes it - and a fingerprint is client-derived
// anyway, so nothing is protected by hiding it from the client that produced
// it. It is re-hashed with the server salt before storage.
export const FINGERPRINT_COOKIE = "hearth_fp";

const FOUR_HUNDRED_DAYS_SECONDS = 400 * 24 * 60 * 60;

// Routes that are fetched by machines, not people: crawlers, link scrapers, and
// the OS asking for an icon. A Set-Cookie on any of them tells the CDN not to
// cache a response that is identical for everybody, and plants a 400-day device
// cookie in a bot that will never sign up for anything.
//
// These are extensionless (so the file-extension check below cannot catch them)
// and generated out of src/app, so they go through the middleware like any other
// page. startsWith, not exact match, because Next can serve metadata variants
// with generated suffixes (/opengraph-image-abc123).
const METADATA_PREFIXES = [
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/opengraph-image",
  "/apple-icon",
  "/icon",
  "/favicon",
];

// Does the last path segment look like a file? Anything with an extension is a
// static asset or a generated image, never a page somebody is reading.
function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return /\.[a-z0-9]{1,8}$/i.test(last);
}

// The ONLY paths that get a device cookie: the signup, onboarding and payment
// funnel. Everything the score ever asks is "were several accounts created or
// paid for from this browser", and both of those happen here - so a cookie
// planted anywhere else can never be read for anything, it just costs the CDN
// a cacheable response.
//
// This used to be an exclusion list (skip /api, skip files, skip metadata) and
// therefore an allow-by-default: every marketing page, every /p/<pro> profile,
// every guide sent a 400-day Set-Cookie to first-time readers who had not
// asked for an account. An allowlist is the honest shape - the funnel is short
// and known, and a visitor who never enters it never gets a cookie at all.
//
// A visitor who reads the marketing site first and signs up later still gets
// their cookie: it is planted on the first funnel page they load, which is
// before any account or payment exists to link.
const DEVICE_COOKIE_PATHS = [
  "/signin",
  "/get-started",
  "/homeowner-signup",
  "/contractor-signup",
  "/welcome",
  "/onboarding",
  "/pro/onboarding",
  "/plus",
  "/pro/plus",
];

// Exact match or a real child segment. Not startsWith on its own: that would
// make "/plush-rugs" a funnel page.
function isFunnelPath(path: string): boolean {
  return DEVICE_COOKIE_PATHS.some(
    (p) => path === p || path.startsWith(`${p}/`)
  );
}

// Plant the device cookie on the response if the request did not carry one.
//
// Called from src/middleware.ts AFTER updateSession has produced its response,
// so it applies to whatever that returned - a plain pass-through, a
// session-refreshed response, or a redirect to /signin. It never reads or
// changes the auth decision.
//
// Planted ONLY on the funnel paths above. The exclusions kept below (/api,
// /_next, file extensions, the metadata routes) are now redundant with the
// allowlist, but they stay as a cheap, obvious first gate: if the allowlist
// ever grows a broad entry, a Stripe webhook and a cached /robots.txt still
// never see a Set-Cookie.
//
// The whole body is wrapped in try/catch. This runs in the middleware, on every
// route in the matcher, so a throw here is not a lost signal - it is the entire
// site down. Returning the untouched response is always a correct answer:
// the worst case is one visitor with no device id, which the score already
// handles (it is one input among many, and its absence reads as "no link").
export function attachDeviceCookie(
  request: NextRequest,
  response: NextResponse
): NextResponse {
  try {
    const path = request.nextUrl.pathname;
    if (path.startsWith("/api/") || path.startsWith("/_next/")) return response;
    if (looksLikeFile(path)) return response;
    if (METADATA_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return response;
    }
    if (!isFunnelPath(path)) return response;
    if (request.cookies.get(DEVICE_COOKIE)?.value) return response;

    response.cookies.set(DEVICE_COOKIE, crypto.randomUUID(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: FOUR_HUNDRED_DAYS_SECONDS,
    });
    return response;
  } catch {
    return response;
  }
}
