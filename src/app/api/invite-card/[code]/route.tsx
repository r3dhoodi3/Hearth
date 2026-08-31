import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { ogFontOption } from "@/lib/ogFont";
import { clientIpFromHeaders } from "@/lib/clientIp";

export const runtime = "nodejs";

// Homeowner invite share card: the image behind a "/homeowner-signup?ref=CODE"
// invite link when a homeowner shares it. Modeled directly on
// src/app/api/win-card/[leadId]/route.tsx and review-card: same 1200x630 size,
// same warm hearth palette, same "no more than a first name and a city, never
// an address or last name" rule those cards already hold to.
//
// Unlike win-card / review-card this route is PUBLIC and unauthenticated: it
// is meant to be fetched by social scrapers rendering a shared link, so there
// is no session to check. That is safe because it carries no more than the two
// public OG cards already do - the inviter's first name (only if trivially on
// record) and their city/state, nothing else. Referral codes are 8 random
// chars from a 31-symbol alphabet (~1e12 space, migration 0099 / referralCode
// .ts), so the code itself is not enumerable, and even a resolved one reveals
// only that low-sensitivity, city-level pair.
//
// v1 is pure neighbor-to-neighbor sharing: the copy never promises a reward,
// credit, or anything of value - it just says a neighbor invited you.

const size = { width: 1200, height: 630 };

// Warm hearth palette (tailwind.config.ts), copied from win-card / review-card
// so all three share cards read as the same product.
const HEARTH_50 = "#fbf7f2";
const HEARTH_500 = "#a9743f";
const HEARTH_700 = "#73482b";
const HEARTH_900 = "#4f3324";

function Wordmark() {
  return (
    <div
      style={{
        position: "absolute",
        top: 48,
        right: 64,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 9999,
          backgroundColor: HEARTH_500,
        }}
      />
      <div style={{ fontSize: 34, fontWeight: 700, color: HEARTH_700 }}>
        Hearth
      </div>
    </div>
  );
}

// First name only: split on whitespace and keep the first token. A blank or
// missing name returns null - the card then falls back to the fully generic
// "A neighbor invited you to Hearth" with no name at all, never a guess.
function firstNameOnly(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

// City, or "City, ST" - never a street. Only ever built from the city/state
// columns directly, so a street address can't reach this card by construction.
function cityState(
  city: string | null | undefined,
  state: string | null | undefined
): string | null {
  const c = (city ?? "").trim();
  if (!c) return null;
  const s = (state ?? "").trim();
  return s ? `${c}, ${s}` : c;
}

export async function GET(req: NextRequest, props: { params: Promise<{ code: string }> }) {
  const params = await props.params;
  const code = (params.code ?? "").trim();

  // Unauthenticated and public, and every hit that carries a plausible code
  // spends two SERVICE-ROLE queries before rendering a 1200x630 image. A code
  // is not enumerable (see the note above), but nothing stopped a caller from
  // hammering this route to burn database and render time either way. Keyed on
  // IP, fixed-window via the shared rate_limit_hit RPC (migration 0068), and
  // checked BEFORE the lookups so a blocked caller costs nothing. Fails open on
  // an RPC hiccup - only an explicit `allowed === false` blocks - so a limiter
  // outage never breaks the card behind a link someone actually shared. The
  // budget is set well above what a social scraper needs for one link.
  const ip = clientIpFromHeaders(req.headers);
  const rlAdmin = createAdminClient();
  const { data: allowed } = await rlAdmin.rpc("rate_limit_hit", {
    p_bucket: `invitecard:${ip ?? "unknown"}`,
    p_limit: 30,
    p_window_seconds: 300,
  });
  if (allowed === false) {
    return new Response("Too many requests", { status: 429 });
  }

  // Resolve the inviter, best-effort. referral_code / referred_by aren't in
  // database.types.ts (not regenerated for 0099), so this is cast to any, the
  // same convention the rest of the referral code uses. RLS hides every users
  // row but the caller's own, and this route has no session at all, so the
  // service-role admin client is the only way to resolve a code here. Any
  // failure (bad code, feature not live, DB hiccup) degrades to the fully
  // generic card rather than erroring.
  let firstName: string | null = null;
  let location: string | null = null;
  if (/^[A-Z0-9]{4,16}$/.test(code)) {
    try {
      const admin = createAdminClient();
      const { data: inviter } = await (admin.from("users") as any)
        .select("id, full_name")
        .eq("referral_code", code)
        .maybeSingle();
      if (inviter?.id) {
        firstName = firstNameOnly(inviter.full_name);
        // City-level only, and only if trivially available: one property row
        // for this inviter that actually has a city. Never a street.
        const { data: prop } = await (admin.from("properties") as any)
          .select("city, state")
          .eq("user_id", inviter.id)
          .not("city", "is", null)
          .limit(1)
          .maybeSingle();
        location = cityState(prop?.city, prop?.state);
      }
    } catch {
      // Generic card below.
    }
  }

  // Honest sublines, no reward language. Built from whatever resolved: name
  // and/or city if we have them, otherwise nothing extra.
  let subline: string | null = null;
  if (firstName && location) {
    subline = `${firstName} keeps on top of their home in ${location} with Hearth.`;
  } else if (firstName) {
    subline = `${firstName} keeps on top of their home with Hearth.`;
  } else if (location) {
    subline = `A homeowner in ${location} uses Hearth to stay on top of their home.`;
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 80px",
          background: HEARTH_50,
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        <Wordmark />

        <div
          style={{
            fontSize: 68,
            fontWeight: 700,
            color: HEARTH_900,
            lineHeight: 1.15,
            maxWidth: 1000,
          }}
        >
          A neighbor invited you to Hearth
        </div>

        {subline && (
          <div
            style={{
              fontSize: 36,
              color: HEARTH_700,
              fontWeight: 600,
              lineHeight: 1.3,
              marginTop: 28,
              maxWidth: 1000,
            }}
          >
            {subline}
          </div>
        )}

        <div
          style={{
            fontSize: 32,
            color: HEARTH_900,
            fontWeight: 600,
            marginTop: 40,
            maxWidth: 1000,
          }}
        >
          Keep track of your home, maintenance, and the pros who work on it.
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: "100%",
            height: 14,
            backgroundColor: HEARTH_500,
          }}
        />
      </div>
    ),
    // Explicit font bytes so @vercel/og never runs its default loader, which
    // throws ERR_INVALID_URL on Windows and 500s the card. See src/lib/ogFont.
    {
      ...size,
      ...ogFontOption(),
      // Public, unauthenticated OG route: cache the rendered card so a flood of
      // requests for the same code can't repeatedly burn satori render compute
      // plus an admin DB lookup. The card only depends on the code, which maps
      // to a stable name/city, so an hour at the edge is safe.
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    }
  );
}
