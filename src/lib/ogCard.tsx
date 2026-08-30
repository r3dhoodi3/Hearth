import { ImageResponse } from "next/og";
import { ogFontOption } from "@/lib/ogFont";

// Shared shell for the guides / pricing / pros social share cards. Mirrors
// the visual pattern already built for src/app/p/[id]/opengraph-image.tsx:
// flat light background, one accent color, a small "Hearth" wordmark in the
// corner, a bottom accent bar, real font via ogFontOption(). No gradients,
// no glass, nothing dynamic to fetch, so every card here is a plain sync
// render. Existing before this: src/app/opengraph-image.tsx (site default,
// dark hearth-600 background) and src/app/p/[id]/opengraph-image.tsx (per-pro
// card, fetches data). This file exists so the guide/pricing/pros cards do
// not each copy-paste the same JSX and palette 15 times.

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

// Same warm hearth palette p/[id]'s card uses (tailwind.config.ts).
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

// Guide titles run 39-71 characters (much longer than a pro's capped-at-60
// display name), so the title wraps to two lines on the longer ones. Scale
// the font down as the title grows so it still fits inside the 1200-wide
// frame without shrinking the short titles more than necessary.
function titleFontSize(title: string): number {
  if (title.length <= 40) return 60;
  if (title.length <= 55) return 52;
  if (title.length <= 70) return 44;
  return 38;
}

// Renders a titled share card: page title, one-line subtitle, wordmark,
// bottom accent bar. Used by every opengraph-image.tsx under guides/,
// pricing/, and pros/ so those routes stay a few lines each.
export function renderOgCard(title: string, subtitle: string) {
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
            fontSize: titleFontSize(title),
            fontWeight: 700,
            color: HEARTH_900,
            lineHeight: 1.15,
            maxWidth: 1000,
          }}
        >
          {title}
        </div>

        <div
          style={{
            fontSize: 34,
            color: HEARTH_700,
            marginTop: 28,
            maxWidth: 950,
          }}
        >
          {subtitle}
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
    { ...OG_SIZE, ...ogFontOption() }
  );
}
