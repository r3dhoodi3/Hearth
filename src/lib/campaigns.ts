// Fixed vocabulary for the 2026-09 social launch's `/go/[code]` redirect
// (src/app/go/[code]/route.ts). See OakTend-marketing/growth/PRODUCTION-BRIEF.md
// item 1 and oaktend-audit/reports/social-growth-verify.md section 6 for the
// background: OakTend's analytics is first-party only (docs/ANALYTICS.md),
// and trackServerEvent (src/lib/trackServer.ts) inserts props RAW - it does
// not run sanitizeTrackProps the way the client /api/track route does. So a
// campaign code must never be written into app_events.props unless it came
// from a fixed, known-safe set: this file is that set.
//
// Shape check first, allowlist second. CAMPAIGN_CODE_RE is a cheap "is this
// even a plausible code" gate that decides 404 vs. a real lookup; it is NOT
// what makes a code safe to log. Only a code present in CAMPAIGN_CODES is
// ever written to app_events.props.code as itself - anything well-formed but
// not in the map redirects to "/" and is logged with the fixed literal
// "unknown_code" in place of the caller-supplied string, so a stranger
// probing /go/whatever-they-typed can never inject free text into analytics.

import { legacyKey } from "@/lib/legacyStorage";

export const CAMPAIGN_CODE_RE = /^[a-z0-9-]{2,32}$/;

export type CampaignChannel = "tiktok" | "instagram" | "other";

export interface CampaignLink {
  /** Path on this site the code redirects to. Always starts with "/". */
  destination: string;
  channel: CampaignChannel;
  /** Short human label for the GO-LINKS.md table and any future dashboard. */
  label: string;
}

// The 28 codes CONTENT-CALENDAR-2WEEKS.md actually uses: ig-d01..d14 and
// tt-d01..d14 (grepped from OakTend-marketing/growth/CONTENT-CALENDAR-2WEEKS.md
// on 2026-09-07). Three days point at /pros instead of the homepage because
// the calendar labels them pro days: Day 3, Day 8, Day 13.
const PRO_DAYS = new Set([3, 8, 13]);

function dayCode(prefix: "ig" | "tt", day: number): string {
  return `${prefix}-d${String(day).padStart(2, "0")}`;
}

function buildCalendarCodes(): Record<string, CampaignLink> {
  const map: Record<string, CampaignLink> = {};
  for (const [prefix, channel] of [
    ["ig", "instagram"],
    ["tt", "tiktok"],
  ] as const) {
    for (let day = 1; day <= 14; day++) {
      const code = dayCode(prefix, day);
      const isPro = PRO_DAYS.has(day);
      map[code] = {
        destination: isPro ? "/pros" : "/",
        channel,
        label: `Day ${day}${isPro ? " (pro)" : ""}`,
      };
    }
  }
  return map;
}

// code -> destination/channel/label. Only codes in this object are ever
// logged with their real value; see the module comment above.
export const CAMPAIGN_CODES: Readonly<Record<string, CampaignLink>> =
  Object.freeze(buildCalendarCodes());

// Fixed, enum-safe placeholder logged in place of a well-formed code that
// is not in CAMPAIGN_CODES. Never derived from caller input.
export const UNKNOWN_CAMPAIGN_CODE = "unknown_code";

/** True only for a code shaped like a campaign code, says nothing about whether it's real. */
export function isWellFormedCampaignCode(code: string): boolean {
  return CAMPAIGN_CODE_RE.test(code);
}

/** Looks up a code in the fixed allowlist. Returns null for anything not on it, well-formed or not. */
export function lookupCampaign(code: string): CampaignLink | null {
  if (!isWellFormedCampaignCode(code)) return null;
  return CAMPAIGN_CODES[code] ?? null;
}

// First-party attribution cookie set by src/app/go/[code]/route.ts on a
// known code, read back by src/app/(auth)/recordTermsAcceptance.ts (the
// shared homeowner/contractor signup hook) to log campaign_signup. Named
// here, not in the route file, because a Next.js route.ts module may only
// export the HTTP method handlers and a small fixed set of config keys -
// any other export there is invalid.
export const CAMPAIGN_COOKIE = "oaktend_campaign";

// Brand rename cleanup, remove after 2026-12-31. The pre-rename name of the
// cookie above, built out of two literal halves by src/lib/legacyStorage.ts so
// the old brand word never appears whole in src. Nothing WRITES this name any
// more: recordTermsAcceptance promotes a value found under it onto
// CAMPAIGN_COOKIE (same options as below) and deletes it, so the new name is
// never left as an empty slot that a reader would still prefer.
export const LEGACY_CAMPAIGN_COOKIE = legacyKey(CAMPAIGN_COOKIE);

const CAMPAIGN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Conditional on production, same convention as passwordRecoveryCookieOptions
// (src/lib/passwordRecovery.ts): a `secure` cookie is dropped on plain http,
// and local dev runs on http://localhost.
export function campaignCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: CAMPAIGN_COOKIE_MAX_AGE_SECONDS,
  };
}
