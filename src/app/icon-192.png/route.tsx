import { ImageResponse } from "next/og";

// Android/Chrome install icon at 192x192, referenced by src/app/manifest.ts.
// Not a special Next.js icon-file convention (those only auto-detect exact
// names like icon.tsx / apple-icon.tsx), so this is a plain Route Handler
// under a literal "icon-192.png" folder that returns the PNG bytes directly -
// same ImageResponse call src/app/apple-icon.tsx uses, just a fixed,
// predictable URL for the manifest to point at. Same house/flame mark and
// same ~69%-of-canvas sizing as apple-icon.tsx, which already sits well
// inside the ~80% safe zone Android wants for a maskable icon, so this one
// image works for both the "any" and "maskable" purposes declared in the
// manifest - no separate padded asset needed.
const SIZE = 192;
const MARK = 132; // keep the same ~69% ratio apple-icon.tsx uses (124/180)

// Cache hard. This handler takes no input at all - no params, no query, no
// cookies, no database - so its bytes are a constant of the deployment and can
// only change when the artwork above is edited and redeployed. A GET route
// handler is dynamic by default in Next 15, so without this every install
// prompt and every Android home-screen refresh re-runs a satori render on the
// server for a picture that never changes. attachDeviceCookie already skips
// /icon* and any path with a file extension (src/lib/risk/cookies.ts), so no
// Set-Cookie rides along to make the CDN refuse to store it.
//
//   s-maxage=31536000  the CDN may hold it until the next deploy, which
//                      invalidates the cache anyway.
//   max-age=86400      a browser re-checks daily, so a changed icon reaches an
//                      already-installed app within a day rather than never.
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
