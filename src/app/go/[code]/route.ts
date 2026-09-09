import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIpFromHeaders } from "@/lib/clientIp";
import { requestOrigin } from "@/lib/requestOrigin";
import { trackServerEvent } from "@/lib/trackServer";
import {
  isWellFormedCampaignCode,
  lookupCampaign,
  UNKNOWN_CAMPAIGN_CODE,
  CAMPAIGN_COOKIE,
  campaignCookieOptions,
} from "@/lib/campaigns";

export const runtime = "nodejs";

// First-party campaign-click redirect for the 2026-09 social launch. See
// OakTend-marketing/growth/PRODUCTION-BRIEF.md item 1 and
// oaktend-audit/reports/social-growth-verify.md section 6: OakTend's campaign
// attribution is first-party only (cookieless analytics only, see
// docs/ANALYTICS.md - the privacy policy promises no advertising SDK, no ad
// pixel or retargeting tag in writing), so a bio link or Story sticker
// pointing straight at oaktend.com produces no per-post click data. This
// route is the whole mechanism: /go/<code> logs one app_events row and
// redirects, no pixel, no third-party tag, nothing leaves this server.
//
// The code is NEVER trusted as free text. trackServerEvent
// (src/lib/trackServer.ts) inserts props RAW - unlike the client
// /api/track route, it does not run sanitizeTrackProps - so this route is
// the only thing standing between a stranger's request path and a raw
// string landing in app_events.props. src/lib/campaigns.ts is the fixed
// allowlist: a code is only ever logged as itself when it is a real,
// known campaign code. Anything else redirects home and is logged with the
// fixed literal "unknown_code" in place of whatever the caller typed.
export async function GET(
  req: NextRequest,
  props: { params: Promise<{ code: string }> }
) {
  const { code: rawCode } = await props.params;
  const code = (rawCode ?? "").trim();

  // Shape check: not the allowlist, just "is this even worth a lookup".
  // Malformed paths (wrong length, uppercase, punctuation) 404 outright and
  // are never logged - there is nothing well-formed enough here to be worth
  // an unknown_code row, and it keeps a scanner hammering random paths from
  // generating analytics noise.
  if (!isWellFormedCampaignCode(code)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const origin = requestOrigin(req);
  const ip = clientIpFromHeaders(req.headers);

  // Light throttle, same shared RPC and fail-open shape as
  // src/app/api/track/route.ts's own limiter: this is a public,
  // unauthenticated GET, so it needs a bucket before doing any work, but a
  // link in a bio or a Story sticker gets real bursts of legitimate clicks,
  // so the limit is generous. On a hit, still redirect (a rate-limited
  // visitor should not see a broken link) but skip the tracking insert.
  let rateLimited = false;
  try {
    const admin = createAdminClient();
    const { data: allowed } = await admin.rpc("rate_limit_hit", {
      p_bucket: `go:${ip ?? "unknown"}`,
      p_limit: 120,
      p_window_seconds: 300,
    });
    rateLimited = allowed === false;
  } catch {
    // Fail open, same convention as every other rate_limit_hit caller: a
    // limiter hiccup must never turn into a broken campaign link.
  }

  const link = lookupCampaign(code);

  const uaFamily = mobileOrDesktop(req.headers.get("user-agent"));
  const refererHost = refererHostOnly(req.headers.get("referer"));

  if (!rateLimited) {
    if (link) {
      await trackServerEvent(null, "campaign_click", {
        code,
        channel: link.channel,
        label: link.label,
        ua_family: uaFamily,
        referer_host: refererHost,
      });
    } else {
      // Well-formed but not a real code: log the fixed placeholder, never
      // the caller-supplied string. See the module comment above.
      await trackServerEvent(null, "campaign_click", {
        code: UNKNOWN_CAMPAIGN_CODE,
        channel: "other",
        label: null,
        ua_family: uaFamily,
        referer_host: refererHost,
      });
    }
  }

  const destinationPath = link?.destination ?? "/";
  const redirectUrl = new URL(destinationPath, origin);
  const res = NextResponse.redirect(redirectUrl, 302);

  // First-party attribution cookie, set only for a real code: lets the
  // homeowner/contractor signup server actions log campaign_signup later
  // without the code ever appearing in a query string (no query params
  // leak from this redirect - the cookie carries it instead). httpOnly so
  // no page script can read or forge it; sameSite lax so it survives the
  // top-level navigation a bio-link tap performs.
  if (link) {
    res.cookies.set(CAMPAIGN_COOKIE, code, campaignCookieOptions());
  }

  return res;
}

// Coarse device family only, never the raw User-Agent string: ANALYTICS.md's
// payload rule is ids and enums only. Same signal installState.ts already
// uses client-side for iOS detection, applied here to the header instead of
// navigator.userAgent.
function mobileOrDesktop(ua: string | null): "mobile" | "desktop" {
  if (!ua) return "desktop";
  return /Mobi|Android|iPhone|iPad|iPod/.test(ua) ? "mobile" : "desktop";
}

// Hostname only, never the full referer URL (which can carry a path, a
// query string, or a fragment with anything in it). Invalid/missing referer
// -> null, not an empty string, so it reads cleanly as "no referer" in a
// query against props.
function refererHostOnly(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname || null;
  } catch {
    return null;
  }
}
