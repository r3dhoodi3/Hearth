import { ImageResponse } from "next/og";
import { ogFontOption } from "@/lib/ogFont";

// Default social share card for every page that doesn't own a more specific
// one (the pro profile page has its own: src/app/p/[id]/opengraph-image.tsx).
// Flat single-color background, no gradient, matching the rest of the brand:
// this is the same oaktend-600 ember accent .btn-primary uses (see
// tailwind.config.ts), inlined as a hex value since satori (what next/og's
// ImageResponse renders with) can't read Tailwind classes.

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "OakTend: your home, looked after";

const OAKTEND_600 = "#b8442a";
const OAKTEND_100 = "#f6e4dc";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: OAKTEND_600,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {/* Same house-and-flame mark as components/Logo.tsx, redrawn with
              explicit white fill/stroke instead of currentColor: satori
              renders each image standalone, with no CSS cascade to inherit
              color from. */}
          <svg
            width="84"
            height="84"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 11.5 12 4l4 3.33V5.5h2.5v3.92L21 11.5" />
            <path d="M5 10.5V20h14v-9.5" />
            <path
              d="M12 17.8c1.8 0 3-1.2 3-2.8 0-1.9-1.7-2.6-2.2-4-.9.6-1 1.5-.9 2.2-.6-.2-1-.6-1.2-1.2-.9.8-1.7 1.9-1.7 3 0 1.6 1.2 2.8 3 2.8z"
              fill="#fff"
              stroke="none"
            />
          </svg>
          <div style={{ fontSize: 96, fontWeight: 700, color: "#fff" }}>
            OakTend
          </div>
        </div>
        <div
          style={{
            fontSize: 40,
            color: OAKTEND_100,
            marginTop: 32,
            maxWidth: 900,
            textAlign: "center",
          }}
        >
          Know what your home needs before it costs you
        </div>
      </div>
    ),
    { ...size, ...ogFontOption() }
  );
}
