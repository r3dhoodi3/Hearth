import { ImageResponse } from "next/og";

// Android/Chrome install icon at 512x512, referenced by src/app/manifest.ts.
// See src/app/icon-192.png/route.tsx for why this is a hand-written Route
// Handler rather than a special icon-file convention, and why the same flat,
// full-bleed image works for both the "any" and "maskable" manifest
// purposes.
const SIZE = 512;
const MARK = 352; // keep the same ~69% ratio apple-icon.tsx uses (124/180)

// Same reasoning as src/app/icon-192.png/route.tsx: no input of any kind, so
// the bytes are a constant of the deployment. Cached at the CDN until the next
// deploy, re-checked daily by the browser.
const ICON_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fbf7f2",
        }}
      >
        <svg
          width={MARK}
          height={MARK}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#915d32"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 11.5 12 4l4 3.33V5.5h2.5v3.92L21 11.5" />
          <path d="M5 10.5V20h14v-9.5" />
          <path
            d="M12 17.8c1.8 0 3-1.2 3-2.8 0-1.9-1.7-2.6-2.2-4-.9.6-1 1.5-.9 2.2-.6-.2-1-.6-1.2-1.2-.9.8-1.7 1.9-1.7 3 0 1.6 1.2 2.8 3 2.8z"
            fill="#73482b"
            stroke="none"
          />
        </svg>
      </div>
    ),
    {
      width: SIZE,
      height: SIZE,
      headers: { "Cache-Control": ICON_CACHE_CONTROL },
    }
  );
}
