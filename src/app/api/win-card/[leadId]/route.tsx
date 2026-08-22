import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { JOB_CATEGORIES, labelFor } from "@/lib/constants";
import { ogFontOption } from "@/lib/ogFont";

export const runtime = "nodejs";

// Win share card: a celebratory image a pro can post after winning a job.
//
// SCOPE (owner decision): this card carries ZERO homeowner information. No
// homeowner name, no street address, no job description, no price. It only
// ever shows the pro's own business name and logo, the job's trade category,
// the city and state parsed from the lead's snapshot address (never the
// street segment), the pro's real star rating and review count when they
// have at least one review, and Hearth's own branding plus their public page
// link. Because no homeowner data ever reaches this route or the image it
// renders, there is no consent flow to build or check here.
//
// Visual style matches src/app/p/[id]/opengraph-image.tsx exactly: same
// warm hearth palette, same 1200x630 size, same hand drawn Star (satori's
// default font has no reliable star glyph, so stars stay SVG rather than a
// unicode character).

const size = { width: 1200, height: 630 };

// Warm hearth palette (tailwind.config.ts), copied from opengraph-image.tsx
// so both share cards read as the same product.
const HEARTH_50 = "#fbf7f2";
const HEARTH_500 = "#a9743f";
const HEARTH_700 = "#73482b";
const HEARTH_900 = "#4f3324";
const STONE_400 = "#a8a29e";
const STONE_300 = "#d6d3d1";
const AMBER_500 = "#f59e0b";

function Star({ filled }: { filled: boolean }) {
  return (
    <svg
      width="40"
      height="40"
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

// Everything after the first comma of a snapshot address like
// "123 Main St, Springfield, IL" (built in (app)/contractors/actions.ts as
// [address_line1, city, state].join(", ")). The street segment before that
// first comma is discarded and never returned, so a street address can never
// reach this card. A missing comma (no city or state on record) returns
// null rather than guessing.
function cityState(propertyAddress: string | null): string | null {
  if (!propertyAddress) return null;
  const commaIndex = propertyAddress.indexOf(",");
  if (commaIndex === -1) return null;
  const rest = propertyAddress.slice(commaIndex + 1).trim();
  return rest.length > 0 ? rest : null;
}

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// Build an absolute, fetchable URL for the logo. Stored values are usually a
// full public URL (getPublicUrl output), but legacy rows can hold a bare
// object path (see src/lib/storage.ts). Satori calls new URL() on an <img
// src>, so a bare path throws "Invalid URL" and 500s the whole card, which the
// browser then surfaces as a failed download ("no internet"). Normalize first,
// and skip the logo entirely if we can't make it absolute.
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
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const type = resp.headers.get("content-type") || "image/png";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, props: { params: Promise<{ leadId: string }> }) {
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

  const { data: leadRow } = await supabase
    .from("contractor_leads")
    .select("id, category, status, paid, property_address, contractor_id")
    .eq("id", params.leadId)
    .maybeSingle();

  if (!leadRow) return notFound();
  // Ownership: only the contractor this lead is assigned to can render its
  // card, and only once it is actually won. Win state mirrors how the rest
  // of the app treats a lead: paid for, or moved to accepted or closed in
  // the pipeline (see STATUS_LABEL on /pro/business, and stageForLeadStatus
  // on /pro/crm, where closed maps to "won").
  if (leadRow.contractor_id !== contractor.id) return notFound();
  const isWon =
    Boolean(leadRow.paid) ||
    leadRow.status === "accepted" ||
    leadRow.status === "closed";
  if (!isWon) return notFound();

  // logo_url and slug are 0033/0043 columns not present in the generated
  // Contractor type (database.types.ts is not regenerated here), so they are
  // read off an any cast, same pattern as PublicPageCard.tsx.
  const extra = contractor as any;
  // Inlined as a data URI (or null) so satori never parses/fetches the URL at
  // render time - a bare legacy path here used to throw "Invalid URL" and 500
  // the download.
  const logoUrl = await logoDataUri(extra.logo_url ?? null);
  const slug: string | null = extra.slug ?? null;

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? req.nextUrl.origin;
  const publicPageUrl = `${site}/p/${slug ?? contractor.id}`;

  const hasRating = contractor.review_count > 0 && contractor.rating != null;
  const fullStars = hasRating ? Math.round(contractor.rating!) : 0;

  // Label only, no emoji icon: unlike the plain text this route otherwise
  // renders, a raw unicode glyph makes satori fetch a twemoji SVG for it from
  // an external CDN at render time. If that fetch fails or is blocked, the
  // whole card fails mid-stream, which is exactly what corrupted this card's
  // downloads before this fix. Same reasoning as the hand-drawn Star SVG
  // above and the icon-free categoryLine in opengraph-image.tsx.
  const categoryLabel = labelFor(JOB_CATEGORIES, leadRow.category);
  const location = cityState(leadRow.property_address);
  const celebrationLine = location
    ? `Another ${categoryLabel} job won in ${location} on Hearth.`
    : `Another ${categoryLabel} job won on Hearth.`;

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

        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 28,
          }}
        >
          <div style={{ fontSize: 32, color: HEARTH_700, fontWeight: 600 }}>
            {categoryLabel}
          </div>
        </div>

        <div
          style={{
            fontSize: 44,
            fontWeight: 700,
            color: HEARTH_900,
            lineHeight: 1.25,
            marginTop: 28,
            maxWidth: 1000,
          }}
        >
          {celebrationLine}
        </div>

        {hasRating && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginTop: 32,
            }}
          >
            <div style={{ display: "flex", gap: 4 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <Star key={i} filled={i < fullStars} />
              ))}
            </div>
            <div style={{ fontSize: 38, fontWeight: 700, color: HEARTH_900 }}>
              {contractor.rating}
            </div>
            <div style={{ fontSize: 30, color: STONE_400 }}>
              {contractor.review_count} review
              {contractor.review_count === 1 ? "" : "s"}
            </div>
          </div>
        )}

        <div style={{ fontSize: 28, color: HEARTH_700, marginTop: 32 }}>
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
    // Pass the font bytes explicitly (ogFontOption) so @vercel/og never runs
    // its default font auto-loader, which throws ERR_INVALID_URL on Windows and
    // 500s the whole card. Spreads to just `size` if the font file isn't found.
    { ...size, ...ogFontOption() }
  );
}
