import { ImageResponse } from "next/og";
import { createClient } from "@supabase/supabase-js";
import { JOB_CATEGORIES, labelFor } from "@/lib/constants";
import { isAcceptableCustomCategory } from "@/lib/customCategory";
import { ogFontOption } from "@/lib/ogFont";

// Social share card for a pro's public page (/p/[id]). Rendered on demand by
// next/og; Next wires it into the page's og:image / twitter:image tags.
//
// Data comes from the SAME public_pro_profile RPC the page uses, via a bare
// anon-key client (no cookies, no service role: the RPC is already public by
// design, 0033). Any failure, missing row, or pre-migration state falls back
// to a generic branded card so the route can never 500 a crawler.

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Hearth pro profile";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Warm hearth palette (tailwind.config.ts).
const HEARTH_50 = "#fbf7f2";
const HEARTH_500 = "#a9743f";
const HEARTH_700 = "#73482b";
const HEARTH_900 = "#4f3324";
const STONE_400 = "#a8a29e";
const STONE_300 = "#d6d3d1";
const AMBER_500 = "#f59e0b";

type OgProfile = {
  name: string;
  categories: string[];
  rating: number | null;
  review_count: number;
};

async function fetchProfile(param: string): Promise<OgProfile | null> {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    let id = param;
    if (!UUID_RE.test(param)) {
      const { data, error } = await (supabase.rpc as any)(
        "public_pro_id_for_slug",
        { p_slug: param }
      );
      if (error || !data) return null;
      id = data as string;
    }
    const { data, error } = await (supabase.rpc as any)("public_pro_profile", {
      p_contractor: id,
    });
    if (error || !data) return null;
    return data as OgProfile;
  } catch {
    return null;
  }
}

// Satori's default font has no reliable star glyph, so stars are drawn as SVG.
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

export default async function OgImage({
  params,
}: {
  params: { id: string };
}) {
  const profile = await fetchProfile(params.id);

  const frame = {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column" as const,
    justifyContent: "center",
    padding: "0 80px",
    background: HEARTH_50,
    position: "relative" as const,
    fontFamily: "sans-serif",
  };

  if (!profile || !profile.name) {
    // Fallback card: still branded, never blank or broken.
    return new ImageResponse(
      (
        <div style={{ ...frame, alignItems: "center" }}>
          <div style={{ fontSize: 84, fontWeight: 700, color: HEARTH_900 }}>
            Hearth
          </div>
          <div style={{ fontSize: 36, color: HEARTH_700, marginTop: 16 }}>
            Trusted pros for your home
          </div>
        </div>
      ),
      { ...size, ...ogFontOption() }
    );
  }

  const hasRating = profile.review_count > 0 && profile.rating != null;
  // Same rounding the page's star row uses.
  const fullStars = hasRating ? Math.round(profile.rating!) : 0;
  // Same render-side filter as the profile page: canonical values pass,
  // custom ones must clear the moderation predicate (legacy rows predate it).
  const canonical = new Set<string>(JOB_CATEGORIES.map((c) => c.value));
  const categoryLine = (profile.categories ?? [])
    .filter((c) => canonical.has(c) || isAcceptableCustomCategory(c))
    .slice(0, 3)
    .map((c) => labelFor(JOB_CATEGORIES, c))
    .join("  ·  ");
  // A business name is free-text a pro controls (pro/actions.ts). Capped
  // here so a crafted/very-long name can't blow up satori's layout - same
  // "never let untrusted text 500 a public card" rule as win-card/
  // review-card's excerpt()/name handling.
  const displayName =
    profile.name.length > 60
      ? `${profile.name.slice(0, 60).trimEnd()}…`
      : profile.name;

  try {
    return new ImageResponse(
      (
        <div style={frame}>
          <Wordmark />

          <div
            style={{
              fontSize: displayName.length > 28 ? 58 : 76,
              fontWeight: 700,
              color: HEARTH_900,
              lineHeight: 1.1,
              maxWidth: 1000,
            }}
          >
            {displayName}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              marginTop: 36,
            }}
          >
            {hasRating ? (
              <>
                <div style={{ display: "flex", gap: 4 }}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Star key={i} filled={i < fullStars} />
                  ))}
                </div>
                <div style={{ fontSize: 44, fontWeight: 700, color: HEARTH_900 }}>
                  {profile.rating}
                </div>
                <div style={{ fontSize: 36, color: STONE_400 }}>
                  {profile.review_count} review
                  {profile.review_count === 1 ? "" : "s"}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 36, color: STONE_400 }}>
                New on Hearth
              </div>
            )}
          </div>

          {categoryLine && (
            <div style={{ fontSize: 34, color: HEARTH_700, marginTop: 28 }}>
              {categoryLine}
            </div>
          )}

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
      { ...size, ...ogFontOption() }
    );
  } catch (err) {
    // Belt-and-suspenders: displayName is already length-capped above, but
    // satori can still choke on other free-text (categoryLine, unusual
    // unicode, etc). Never let a crafted profile 500 this public route -
    // fall back to the same generic branded card used when the profile
    // itself is missing.
    console.error("opengraph-image render failed", err);
    return new ImageResponse(
      (
        <div style={{ ...frame, alignItems: "center" }}>
          <div style={{ fontSize: 84, fontWeight: 700, color: HEARTH_900 }}>
            Hearth
          </div>
          <div style={{ fontSize: 36, color: HEARTH_700, marginTop: 16 }}>
            Trusted pros for your home
          </div>
        </div>
      ),
      { ...size, ...ogFontOption() }
    );
  }
}
