// Server-only. Looks up a California contractor license against the CSLB
// (Contractors State License Board) public license-check page. There is no
// official API for this: it fetches the same public HTML page a homeowner
// would see at cslb.ca.gov and scrapes the fields with regex (no cheerio, no
// jsdom, no new dependency, per the "no new dependencies" rule for this
// feature).
//
// THIS PARSES A GOVERNMENT WEBSITE OAKTEND DOES NOT CONTROL. Its markup can
// change at any time without notice and silently break this parser. Whenever
// the page's shape can't be recognized (or the fetch fails outright), this
// returns outcome 'error'. Callers MUST treat 'error' as "we don't know",
// never as a failed check: a pro's verification status must never be
// downgraded because CSLB changed a <div> id or timed out. Only 'not_found'
// and 'inactive' are affirmative, actionable results.
//
// URL shape and parsing were confirmed against the real site while building
// this (two real lookups only, per the polite-use budget for this feature):
//   https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=270663
//     -> a real (canceled) license: full results table.
//   https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum=99
//     -> "License Number does not exist." (not_found shape).
// Note the host is www2.cslb.ca.gov, not www.cslb.ca.gov.

export type CslbOutcome = "active" | "inactive" | "not_found" | "error";

export type CslbLookupResult = {
  outcome: CslbOutcome;
  businessName?: string;
  statusText?: string;
  classifications?: string[];
  expires?: string;
};

const CSLB_BASE = "https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII";
const CHECK_LICENSE_URL = `${CSLB_BASE}/CheckLicense.aspx`;

// A normal desktop Chrome UA, as requested: CSLB sits behind a WAF (F5/BigIP
// "TS..." cookies) that appears to gate on looking like a real browser
// session rather than anything specific to CSLB. Hitting LicenseDetail.aspx
// cold, with no prior request on the site, gets silently redirected back to
// the search page instead of returning the detail page; visiting
// CheckLicense.aspx first (to pick up its session cookie) and sending it
// back with a Referer on the detail request is what got a real 200.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// CSLB license numbers are purely numeric. Strips everything else so a pro
// who typed "LIC# 270663" or "270-663" still resolves to a checkable number;
// a value with no digits at all is rejected without ever hitting the network
// (there is nothing to check, and it's not a fetch failure, so this never
// returns 'not_found' for a garbage input, only from a real CSLB response).
function sanitizeLicenseNumber(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

// Node's fetch (undici) exposes multiple Set-Cookie values via
// getSetCookie(); fall back to the single combined header for older
// runtimes. Only the name=value pairs are kept, same as a browser would send
// them back.
function cookieHeaderFrom(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];
  if (raw.length === 0) return null;
  return raw.map((c) => c.split(";")[0]).join("; ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Parses the CSLB LicenseDetail.aspx page. Exported separately from the
// fetch so the parsing logic (the part most likely to need a fix when CSLB
// changes their markup) can be exercised without a network call.
export function parseCslbDetailHtml(html: string): CslbLookupResult {
  // "Not found": CSLB renders a dedicated error span in place of the results
  // table when the license number has no record at all. Confirmed live with
  // LicNum=99: <span id="MainContent_ErrMsg" ...>License Number does not
  // exist.</span>
  const errMatch = html.match(
    /id="MainContent_ErrMsg"[^>]*>([\s\S]*?)<\/span>/i
  );
  if (errMatch) {
    return { outcome: "not_found", statusText: stripTags(errMatch[1]) };
  }

  const busInfoMatch = html.match(
    /id="MainContent_BusInfo"[^>]*>([\s\S]*?)<\/td>/i
  );
  const statusMatch = html.match(
    /id="MainContent_Status"[^>]*>([\s\S]*?)<\/td>/i
  );

  if (!busInfoMatch || !statusMatch) {
    // Loaded a page, but neither the results table nor the not-found message
    // is recognizable. CSLB likely changed their markup: never guess an
    // outcome from a shape we don't understand.
    return { outcome: "error", statusText: "Unrecognized CSLB page shape." };
  }

  // Business name is the first line of the Business Information cell, which
  // packs name / dba / address / phone separated by <br> tags, e.g.
  // "L B POWERS AND SON PLUMBING CO INC<br />dba POWERS PLUMBING<br />...".
  const nameLine = busInfoMatch[1].split(/<br\s*\/?>/i)[0] ?? "";
  const businessName = stripTags(nameLine) || undefined;

  // e.g. "This license is current and active." or "This license is canceled
  // and not able to contract." (confirmed live with LicNum=270663).
  const statusText = stripTags(statusMatch[1]) || undefined;

  const expireMatch = html.match(/id="MainContent_ExpDt"[^>]*>([^<]*)</i);
  const expires = expireMatch
    ? decodeEntities(expireMatch[1]).trim() || undefined
    : undefined;

  // Classifications live as one or more "<a ...>CODE - LABEL</a>" links
  // inside the Classifications cell, e.g. "C36 - PLUMBING".
  const classSectionMatch = html.match(
    /id="MainContent_ClassCellTable"[^>]*>([\s\S]*?)<\/td>/i
  );
  const classifications = classSectionMatch
    ? Array.from(classSectionMatch[1].matchAll(/<a[^>]*>([^<]*)<\/a>/gi))
        .map((m) => stripTags(m[1]))
        .filter(Boolean)
    : [];

  // "current and active" is CSLB's own phrasing for a good-standing license.
  // A downgrade to 'inactive' requires a RECOGNIZED negative phrasing
  // (canceled, expired, suspended, revoked, "not able to contract"): a
  // status sentence matching neither list means CSLB changed their wording,
  // and guessing "inactive" there would strip real pros' verified badges the
  // day CSLB edits copy. Unrecognized wording is 'error' (leave status
  // as-is), never a confident negative.
  const NEGATIVE_STATUS =
    /cancel|expired|suspend|revok|inactive|not able to contract/i;
  let outcome: CslbOutcome;
  if (statusText && /current and active/i.test(statusText)) {
    outcome = "active";
  } else if (statusText && NEGATIVE_STATUS.test(statusText)) {
    outcome = "inactive";
  } else {
    return {
      outcome: "error",
      businessName,
      statusText: statusText ?? "Unrecognized CSLB status wording.",
      classifications:
        classifications.length > 0 ? classifications : undefined,
      expires,
    };
  }

  return {
    outcome,
    businessName,
    statusText,
    classifications: classifications.length > 0 ? classifications : undefined,
    expires,
  };
}

// Looks up a license number against CSLB. Never throws: every failure mode
// (bad input, network error, timeout, unrecognized page) resolves to a typed
// result with outcome 'error' or 'not_found', so callers can await it
// directly.
export async function lookupCslbLicense(
  licenseNumber: string
): Promise<CslbLookupResult> {
  const digits = sanitizeLicenseNumber(licenseNumber);
  // No digits at all, or absurdly long: nothing a real CSLB number looks
  // like. Rejected before ever touching the network. 'error' (not
  // 'not_found'): we didn't actually check anything.
  if (!digits || digits.length > 15) {
    return { outcome: "error", statusText: "Not a checkable license number." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    // Step 1: warm-up request to pick up the WAF's session cookie (see the
    // header comment above). If this fails, the detail fetch below almost
    // certainly will too, but it's allowed to try anyway with no cookie.
    let cookie: string | null = null;
    try {
      const searchRes = await fetch(CHECK_LICENSE_URL, {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
      });
      cookie = cookieHeaderFrom(searchRes);
    } catch {
      // Fall through and try the detail page anyway.
    }

    const detailUrl = `${CSLB_BASE}/LicenseDetail.aspx?LicNum=${digits}`;
    const detailRes = await fetch(detailUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Referer: CHECK_LICENSE_URL,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    });

    if (!detailRes.ok) {
      return {
        outcome: "error",
        statusText: `CSLB returned HTTP ${detailRes.status}.`,
      };
    }

    const html = await detailRes.text();
    return parseCslbDetailHtml(html);
  } catch {
    // AbortError (timeout), DNS/network failure, anything: unknown, never a
    // failed check.
    return { outcome: "error", statusText: "Could not reach the CSLB site." };
  } finally {
    clearTimeout(timeout);
  }
}
