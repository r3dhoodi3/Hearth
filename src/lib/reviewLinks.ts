// Server-side validation for a pro's optional outbound review-page links
// (0110). A pro may link their existing Yelp and Google review pages; the
// public page shows them only as plain "See our reviews" buttons that link
// OUT. OakTend never embeds or imports review content, never shows star counts
// from those sites - a link is the entire feature, which is the zero-ToS-risk
// pattern. This helper is the gatekeeper: it accepts only real business-page
// URLs on the expected hosts and rejects everything else with a friendly
// message, so a pro can never point the button at an arbitrary site.

// Result of validating one link. `value` is the string to store (or null to
// clear the field); an empty input is a valid "clear", not an error.
export type ReviewLinkResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// Hard cap on stored length: a review-page URL is well under this, so anything
// longer is a paste of something else.
const MAX_LEN = 300;

const YELP_HOSTS = new Set(["yelp.com", "www.yelp.com", "m.yelp.com"]);

const GOOGLE_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "maps.google.com",
  "maps.app.goo.gl",
  "g.page",
  "g.co",
  "share.google",
]);

// Parse a candidate into a URL and enforce https. Returns the parsed URL, or
// null when it isn't a well-formed https URL.
function parseHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url;
}

// Shared front half: trim, treat empty as a clear, enforce the length cap.
// Returns a ready result via `done` when there's nothing more to check (empty
// or too long), otherwise the trimmed string for host/path checks.
function precheck(
  raw: string,
  tooLongError: string
): { done: ReviewLinkResult } | { done?: undefined; trimmed: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { done: { ok: true, value: null } };
  if (trimmed.length > MAX_LEN) {
    return { done: { ok: false, error: tooLongError } };
  }
  return { trimmed };
}

// Validate a Yelp business-page link. Accepts https on yelp.com / www.yelp.com
// / m.yelp.com with a path beginning /biz/ (a real business page); rejects
// anything else.
export function validateYelpUrl(raw: string): ReviewLinkResult {
  const tooLong =
    "That Yelp link is too long. Paste just the address of your Yelp business page.";
  const bad =
    "That doesn't look like a Yelp business page link. Open your business on yelp.com and copy the page address (it starts with yelp.com/biz/).";

  const pre = precheck(raw, tooLong);
  if (pre.done) return pre.done;

  const url = parseHttpsUrl(pre.trimmed);
  if (!url) return { ok: false, error: bad };
  if (!YELP_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: bad };
  }
  if (!url.pathname.toLowerCase().startsWith("/biz/")) {
    return { ok: false, error: bad };
  }
  return { ok: true, value: pre.trimmed };
}

// Validate a Google reviews link. Accepts https on the handful of hosts a
// Google business/reviews link legitimately uses, including the short-link
// forms (g.page, g.co, maps.app.goo.gl, share.google); rejects anything else.
export function validateGoogleReviewsUrl(raw: string): ReviewLinkResult {
  const tooLong =
    "That Google link is too long. Paste just the address of your Google page.";
  const bad =
    "That doesn't look like a Google reviews link. Copy the link to your business on Google (a google.com, maps, g.page, or share.google address).";

  const pre = precheck(raw, tooLong);
  if (pre.done) return pre.done;

  const url = parseHttpsUrl(pre.trimmed);
  if (!url) return { ok: false, error: bad };
  if (!GOOGLE_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: bad };
  }
  return { ok: true, value: pre.trimmed };
}
