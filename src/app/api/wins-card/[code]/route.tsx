// Home Wins feature - remove this file (and its parent folder) to remove the
// public share-card half of the feature.
//
// Public "home wins" share card: the 1200x630 image behind a homeowner's
// "share my home wins" link. Modeled EXACTLY on
// src/app/api/invite-card/[code]/route.tsx for security and privacy: same
// public/unauthenticated shape, same IP rate-limit bucket via rate_limit_hit
// (migration 0068), same edge cache, same service-role admin lookup, same code
// validation, and the SAME "no more than a first name, never an address, never
// a value, never a last name" rule the other public cards hold to.
//
// PRIVACY (non-negotiable): this card shows a FIRST NAME and POSITIVE WIN
// COUNTS only. It never renders a street address, a city, a home value, a last
// name, or any dollar figure. The wins themselves are counts of systems and
// tasks (see src/lib/homeWins.ts), which carry no sensitive detail. The [code]
// is the owner's own referral_code - 8 chars from a 31-symbol alphabet
// (~1e12 space, migration 0099 / referralCode.ts), so it is not enumerable, and
// even a resolved one reveals only that low-sensitivity first-name-plus-wins.
//
// DESIGN: a flat, Wrapped-style brag card meant to survive a group chat. One
// full-bleed ember canvas (hearth-600), a paper-ink wordmark, a single
// oversized hero number (the best win), the remaining wins as smaller checked
// rows, and a deep bark baseboard strip. Solid color blocks only - the design
// system bans gradients and glass, and satori is happiest that way too. All
// layout is flexbox with explicit display:flex on every multi-child div
// (satori has no CSS grid and no default block layout).

import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { ogFontOption } from "@/lib/ogFont";
import { selectHomeWins, isValidWinsCode, type HomeWins } from "@/lib/homeWins";
import type { HomeSystem } from "@/lib/database.types";
import { clientIpFromHeaders } from "@/lib/clientIp";

export const runtime = "nodejs";

const size = { width: 1200, height: 630 };

// Brand palette, copied from tailwind.config.ts so the card reads as the same
// product as the app: warm paper, soft bark tints, deep bark ink, and the
// single ember accent that is the whole canvas here.
const BARK_50 = "#fbf7f2";
const BARK_100 = "#f3e9dd";
const BARK_200 = "#e8d8bf";
const BARK_700 = "#73482b";
const EMBER_600 = "#b8442a";

// First name only: split on whitespace and keep the first token. A blank or
// missing name returns null - the card then leads with a generic headline and
// never guesses. Identical to invite-card's helper by design.
function firstNameOnly(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

// All icons are inline SVG, same reasoning as the other cards: a raw unicode
// glyph makes satori fetch a twemoji SVG from an external CDN mid-stream, and
// a failed fetch there corrupts the whole card. Inline paths never leave the
// process.

// Hand-drawn check for the supporting win rows, in paper so it reads on ember.
function Check() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path
        d="M20 6L9 17l-5-5"
        stroke={BARK_50}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Small flame for the wordmark (Hearth = the fire that gets kept going).
function Flame({ px }: { px: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 24 24" fill="none">
      <path
        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
        stroke={BARK_50}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Big house outline, the starter card's hero in place of a number.
function House() {
  return (
    <svg width="150" height="150" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        stroke={BARK_50}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 22V12h6v10"
        stroke={BARK_50}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ code: string }> }
) {
  const params = await props.params;
  const code = (params.code ?? "").trim();

  // Same fixed-window IP limiter as invite-card, checked BEFORE any lookup so a
  // blocked caller costs nothing. Fails open on an RPC hiccup - only an explicit
  // `allowed === false` blocks - so a limiter outage never breaks a card behind
  // a link someone actually shared.
  const ip = clientIpFromHeaders(req.headers);
  const rlAdmin = createAdminClient();
  const { data: allowed } = await rlAdmin.rpc("rate_limit_hit", {
    p_bucket: `winscard:${ip ?? "unknown"}`,
    p_limit: 30,
    p_window_seconds: 300,
  });
  if (allowed === false) {
    return new Response("Too many requests", { status: 429 });
  }

  // Resolve the owner and their home, best-effort. referral_code is not in
  // database.types.ts (not regenerated for 0099), so it is read off an any cast,
  // the same convention the rest of the referral code uses. RLS hides every
  // users row but the caller's own and this route has no session, so the
  // service-role admin client is the only way to resolve a code here. Any
  // failure degrades to the generic starter card rather than erroring.
  let firstName: string | null = null;
  let systems: HomeSystem[] = [];
  let createdAt: string | null = null;
  let tasksDoneCount = 0;

  if (isValidWinsCode(code)) {
    try {
      const admin = createAdminClient();
      const { data: owner } = await (admin.from("users") as any)
        .select("id, full_name")
        .eq("referral_code", code)
        .maybeSingle();
      if (owner?.id) {
        firstName = firstNameOnly(owner.full_name);
        // The owner's oldest home only. created_at drives "years on Hearth".
        // NEVER selects address, city, value, or any location column.
        const { data: prop } = await admin
          .from("properties")
          .select("id, created_at")
          .eq("user_id", owner.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (prop?.id) {
          createdAt = prop.created_at ?? null;
          // last_serviced rides along because isOwnerAssessed (homeWins.ts)
          // needs it to tell an owner-touched system from an onboarding seed.
          const { data: sysRows } = await admin
            .from("home_systems")
            .select(
              "id, property_id, system_type, install_year, last_serviced, condition_rating, expected_lifespan_years, confirmed_at, created_at"
            )
            .eq("property_id", prop.id);
          systems = (sysRows ?? []) as unknown as HomeSystem[];
          const { count } = await admin
            .from("maintenance_tasks")
            .select("id", { count: "exact", head: true })
            .eq("property_id", prop.id)
            .eq("status", "done");
          tasksDoneCount = count ?? 0;
        }
      }
    } catch {
      // Generic starter card below.
    }
  }

  const wins: HomeWins = selectHomeWins({
    firstName,
    createdAt,
    systems,
    tasksDoneCount,
  });

  const starter = wins.variant === "starter";
  // The best win carries the hero number; the rest become supporting rows.
  const hero = wins.wins[0];
  const supporting = wins.wins.slice(1);

  // Third-person headline, first name only. No name resolved => generic.
  const headline = starter
    ? firstName
      ? `${firstName} just put this home on Hearth`
      : "This home just landed on Hearth"
    : firstName
      ? `${firstName} takes care of this place`
      : "This place is taken care of";

  // The card's voice: a small badge of pride, warm and plain, no buzzwords.
  const tagline = starter
    ? "Day one of a well-kept home."
    : "Looked after, and it shows.";

  // Oversized hero number, shrunk for 3+ digits so it never clips.
  const heroStat = !starter && hero?.stat ? hero.stat : null;
  const heroSize = heroStat && heroStat.length >= 3 ? 170 : 230;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: EMBER_600,
          fontFamily: "sans-serif",
        }}
      >
        {/* Padded content column; the baseboard strip below it stays
            full-bleed because the padding lives here, not on the root. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            flexGrow: 1,
            padding: "52px 72px 0",
          }}
        >
        {/* Top bar: wordmark left, inverted paper chip right. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Flame px={34} />
            <div style={{ fontSize: 36, fontWeight: 700, color: BARK_50 }}>
              Hearth
            </div>
          </div>
          <div
            style={{
              display: "flex",
              backgroundColor: BARK_50,
              color: EMBER_600,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: 3,
              textTransform: "uppercase",
              padding: "10px 22px",
              borderRadius: 9999,
            }}
          >
            Home wins
          </div>
        </div>

        {/* Middle: headline, then the one oversized hero, then supporting rows. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: headline.length > 30 ? 40 : 46,
              fontWeight: 700,
              color: BARK_100,
              lineHeight: 1.15,
              maxWidth: 1000,
            }}
          >
            {headline}
          </div>

          {starter ? (
            // Starter hero: a big friendly house instead of an empty number,
            // so a brand-new home still gets something worth posting.
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 40,
                marginTop: 28,
              }}
            >
              <House />
              <div
                style={{
                  fontSize: 52,
                  fontWeight: 700,
                  color: BARK_50,
                  lineHeight: 1.15,
                  maxWidth: 760,
                }}
              >
                {hero?.text ?? "Home set up on Hearth"}
              </div>
            </div>
          ) : heroStat ? (
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 32,
                marginTop: 4,
              }}
            >
              <div
                style={{
                  fontSize: heroSize,
                  fontWeight: 700,
                  color: BARK_50,
                  lineHeight: 1,
                }}
              >
                {heroStat}
              </div>
              <div
                style={{
                  fontSize: 40,
                  fontWeight: 700,
                  color: BARK_100,
                  lineHeight: 1.15,
                  maxWidth: 640,
                  paddingBottom: 24,
                }}
              >
                {hero?.statLabel ?? hero?.text ?? ""}
              </div>
            </div>
          ) : (
            // Defensive: an active win with no split stat still renders big.
            <div
              style={{
                display: "flex",
                fontSize: 60,
                fontWeight: 700,
                color: BARK_50,
                lineHeight: 1.15,
                marginTop: 28,
              }}
            >
              {hero?.text ?? ""}
            </div>
          )}

          {supporting.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                marginTop: 26,
              }}
            >
              {supporting.map((w) => (
                <div
                  key={w.key}
                  style={{ display: "flex", alignItems: "center", gap: 16 }}
                >
                  <Check />
                  <div
                    style={{ fontSize: 30, fontWeight: 600, color: BARK_100 }}
                  >
                    {w.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bottom: the card's voice. */}
        <div
          style={{
            display: "flex",
            fontSize: 26,
            fontWeight: 600,
            color: BARK_200,
            paddingBottom: 34,
          }}
        >
          {tagline}
        </div>
        </div>

        {/* Full-bleed deep bark baseboard block grounding the canvas. */}
        <div
          style={{
            display: "flex",
            width: "100%",
            height: 18,
            backgroundColor: BARK_700,
          }}
        />
      </div>
    ),
    // Explicit font bytes so @vercel/og never runs its default loader, which
    // throws ERR_INVALID_URL on Windows and 500s the card (see src/lib/ogFont).
    {
      ...size,
      ...ogFontOption(),
      // Public, unauthenticated OG route: cache the rendered card so a flood of
      // requests for one code can't repeatedly burn satori render compute plus
      // the admin lookups. The card depends only on the code, which maps to a
      // slow-changing set of wins, so an hour at the edge is safe.
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=3600",
      },
    }
  );
}
