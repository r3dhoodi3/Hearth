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

// Plant the device cookie on the response if the request did not carry one.
//
// Called from src/middleware.ts AFTER updateSession has produced its response,
// so it applies to whatever that returned - a plain pass-through, a
// session-refreshed response, or a redirect to /signin. It never reads or
// changes the auth decision.
//
// Skipped for anything a person is not looking at: /api and /_next, any path
// with a file extension, and the well-known metadata routes above. Two reasons,
// both of which cost nothing to respect: a Stripe or Twilio webhook has no
// browser to keep a cookie in, and a Set-Cookie header on an otherwise
// cacheable response tells the CDN not to cache it. Every path a person
// actually loads in a browser is an extensionless page path, so the signal
// loses nothing by skipping the rest.
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
