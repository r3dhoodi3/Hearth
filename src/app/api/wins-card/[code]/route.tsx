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

import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { ogFontOption } from "@/lib/ogFont";
import { selectHomeWins, isValidWinsCode, type HomeWins } from "@/lib/homeWins";
import type { HomeSystem } from "@/lib/database.types";

export const runtime = "nodejs";

const size = { width: 1200, height: 630 };

// Warm hearth palette (tailwind.config.ts), copied from invite-card / win-card
// so every share card reads as the same product.
const HEARTH_50 = "#fbf7f2";
const HEARTH_500 = "#a9743f";
const HEARTH_700 = "#73482b";
const HEARTH_900 = "#4f3324";
const GREEN_600 = "#16a34a";

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
// missing name returns null - the card then leads with a generic headline and
// never guesses. Identical to invite-card's helper by design.
function firstNameOnly(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

// Hand-drawn check mark, same reasoning as win-card's Star SVG: a raw unicode
// glyph makes satori fetch a twemoji SVG from an external CDN mid-stream, and a
// failed fetch there corrupts the whole card. An inline SVG never leaves the
// process.
function Check() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
      <path
        d="M20 6L9 17l-5-5"
        stroke={GREEN_600}
        strokeWidth="3"
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
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
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
          const { data: sysRows } = await admin
            .from("home_systems")
            .select(
              "id, property_id, system_type, install_year, condition_rating, expected_lifespan_years, confirmed_at, created_at"
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

  // Third-person headline, first name only. No name resolved => generic.
  const headline = firstName
    ? `${firstName} is staying on top of their home`
    : "Staying on top of a home, the easy way";

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
            fontSize: 30,
            fontWeight: 600,
            color: HEARTH_500,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          Home wins
        </div>

        <div
          style={{
            fontSize: headline.length > 34 ? 52 : 60,
            fontWeight: 700,
            color: HEARTH_900,
            lineHeight: 1.15,
            marginTop: 16,
            maxWidth: 1000,
          }}
        >
          {headline}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            marginTop: 40,
          }}
        >
          {wins.wins.map((w) => (
            <div
              key={w.key}
              style={{ display: "flex", alignItems: "center", gap: 18 }}
            >
              <Check />
              <div style={{ fontSize: 40, fontWeight: 600, color: HEARTH_700 }}>
                {w.text}
              </div>
            </div>
          ))}
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
