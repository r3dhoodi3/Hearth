import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { ogFontOption } from "@/lib/ogFont";

export const runtime = "nodejs";

// Review share card: an image a pro can post when a homeowner leaves them a
// strong review. Modeled directly on src/app/api/win-card/[leadId]/route.tsx:
// same 1200x630 size, same warm hearth palette, same "no more homeowner data
// than the win card already shows" rule. The only homeowner detail here is a
// first name (never a last name, never an address or city), read off
// contractor_leads.homeowner_name - the same contact snapshot column the win
// card's ownership check reads from, never the homeowner's account name.
//
// Ratings below 4 never render: a pro sharing a 2-star review makes no sense,
// so anything under 4 stars 404s exactly like an unowned or missing review.

const size = { width: 1200, height: 630 };

// Warm hearth palette (tailwind.config.ts), copied from win-card so both
// share cards read as the same product.
const HEARTH_50 = "#fbf7f2";
const HEARTH_500 = "#a9743f";
const HEARTH_700 = "#73482b";
const HEARTH_900 = "#4f3324";
const STONE_300 = "#d6d3d1";
const AMBER_500 = "#f59e0b";

function Star({ filled }: { filled: boolean }) {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 24 24"
      fill={filled ? AMBER_500 : STONE_300}
    >
      <path d="M12 2l2.9 6.26 6.85.79-5.07 4.67 1.35 6.77L12 17.1l-6.03 3.39 1.35-6.77-5.07-4.67 6.85-.79L12 2z" />
    </svg>
  );
}

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
// missing name (an older lead, or contact fields left empty) degrades to a
// generic, still-honest label rather than guessing at a name.
function firstNameOnly(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "A happy customer";
  return trimmed.split(/\s+/)[0];
}

// First ~140 characters of the review comment, cut cleanly and marked with an
// ellipsis so the card never reads as if it were the whole review. Slicing by
// code POINT (Array.from), not code unit: a .slice() at a raw string index can
// split an emoji's surrogate pair in half, which corrupts the rendered card.
function excerpt(comment: string | null, max = 140): string | null {
  const trimmed = (comment ?? "").trim();
  if (!trimmed) return null;
  const points = Array.from(trimmed);
  if (points.length <= max) return trimmed;
  return `${points.slice(0, max).join("").trimEnd()}…`;
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// Build an absolute, fetchable URL for the logo. Stored values are usually a
// full public URL (getPublicUrl output), but legacy rows can hold a bare
// object path (see src/lib/storage.ts). Satori calls new URL() on an <img
// src>, so a bare path throws "Invalid URL" and 500s the whole card, which the
// browser then surfaces as a failed download ("no internet"). Normalize first,
// and skip the logo entirely if we can't make it absolute. Copied verbatim
// from src/app/api/win-card/[leadId]/route.tsx (a shared src/lib helper would
// be the next step if a third card ever needs it).
//
// Defense in depth: savePublicPageAction (pro/profile/actions.ts) only ever
// stores a Supabase Storage URL scoped to the owning contractor, but this
// function's output is handed straight to fetch() below - a server-side
// request driven by a value an authenticated pro controls. If a full
// https:// value's origin isn't the Supabase Storage origin, treat it as
// untrusted and drop the logo rather than fetch it; this is what actually
// closes the SSRF, since the store-side check alone is one bug away from
// letting an attacker-chosen host through to this fetch().
function absoluteLogoUrl(value: string | null): string | null {
  if (!value) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  let storageOrigin: string;
  try {
    storageOrigin = new URL(base).origin;
  } catch {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).origin === storageOrigin ? value : null;
    } catch {
      return null;
    }
  }
  const path = value.replace(/^\/+/, "").replace(/^pro-logos\//, "");
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/pro-logos/${path}`;
}

// Fetch the logo and inline it as a data URI so satori never does its own
// network fetch or URL parsing while streaming the image (a throw there can't
// be caught by a try/catch around ImageResponse). Any failure (bad URL,
// missing object, non-image, network) just drops the logo: the card still
// renders, it simply leads with the business name.
async function logoDataUri(value: string | null): Promise<string | null> {
  const url = absoluteLogoUrl(value);
  if (!url) return null;
  // Belt and braces around absoluteLogoUrl's own origin check. That function
  // returns a string it BUILT in the relative-path branch, so its output is
  // only ever as trustworthy as that construction; re-deriving the origin from
  // the exact string that is about to be fetched means the one line here that
  // reaches the network is guarded by a check on that line's own argument.
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  try {
    if (new URL(url).origin !== new URL(base).origin) return null;
  } catch {
    return null;
  }
  try {
    // redirect: "error" is the other half of the same fix. Without it a 3xx
    // out of the Supabase Storage origin (a signed-URL rewrite, a proxy in
    // front of the project, a future storage feature) sends this fetch on to
    // whatever host the Location header names, and the origin check above only
    // ever saw the first URL. Following a redirect is not something rendering
    // a logo needs, so refusing one costs nothing.
    const resp = await fetch(url, { redirect: "error" });
    if (!resp.ok) return null;
    const type = resp.headers.get("content-type") || "image/png";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, props: { params: Promise<{ reviewId: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contractor = await getCurrentContractor();
  if (!contractor) {
    return NextResponse.json({ error: "Not a contractor" }, { status: 403 });
  }

  const { data: review } = await supabase
    .from("reviews")
    .select("id, lead_id, contractor_id, rating, comment")
    .eq("id", params.reviewId)
    .maybeSingle();

  if (!review) return notFound();
  // Ownership: only the contractor this review is about can render its card.
  // reviews RLS already limits reads this way, but the check is repeated here
  // explicitly (same pattern as win-card) rather than trusted implicitly.
  if (review.contractor_id !== contractor.id) return notFound();
  // Only 4 and 5 star reviews get a share card at all.
  if (review.rating < 4) return notFound();

  // The reviewer's first name comes off the lead's snapshot contact field,
  // never the homeowner's account: reviews carries no name of its own.
  const { data: leadRow } = await supabase
    .from("contractor_leads")
    .select("homeowner_name")
    .eq("id", review.lead_id)
    .maybeSingle();
  const reviewerFirstName = firstNameOnly(leadRow?.homeowner_name);
  const reviewExcerpt = excerpt(review.comment);

  // logo_url and slug are 0033/0043 columns not present in the generated
  // Contractor type (database.types.ts is not regenerated here), so they are
  // read off an any cast, same pattern as win-card and PublicPageCard.tsx.
  const extra = contractor as any;
  // Inlined as a data URI (or null) so satori never parses/fetches the URL at
  // render time - a bare legacy path here used to throw "Invalid URL" and 500
  // the download.
  const logoUrl = await logoDataUri(extra.logo_url ?? null);
  const slug: string | null = extra.slug ?? null;

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? req.nextUrl.origin;
  const publicPageUrl = `${site}/p/${slug ?? contractor.id}`;

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

        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              width={84}
              height={84}
              style={{ borderRadius: 16, objectFit: "cover" }}
            />
          )}
          <div
            style={{
              fontSize: contractor.name.length > 28 ? 46 : 56,
              fontWeight: 700,
              color: HEARTH_900,
              lineHeight: 1.1,
              maxWidth: 900,
            }}
          >
            {contractor.name}
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 28 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Star key={i} filled={i < review.rating} />
          ))}
        </div>

        <div
          style={{
            fontSize: 34,
            fontWeight: 700,
            color: HEARTH_700,
            marginTop: 16,
          }}
        >
          {review.rating}-star review on Hearth
        </div>

        {reviewExcerpt && (
          <div
            style={{
              fontSize: 40,
              fontWeight: 700,
              color: HEARTH_900,
              lineHeight: 1.3,
              marginTop: 28,
              maxWidth: 1000,
              wordBreak: "break-word",
            }}
          >
            &ldquo;{reviewExcerpt}&rdquo;
          </div>
        )}

        <div
          style={{
            fontSize: 30,
            color: HEARTH_700,
            fontWeight: 600,
            marginTop: 24,
          }}
        >
          - {reviewerFirstName}
        </div>

        <div style={{ fontSize: 28, color: HEARTH_700, marginTop: 40 }}>
          {publicPageUrl}
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
    { ...size, ...ogFontOption() }
  );
}
