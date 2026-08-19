// The Supabase project host, pinned rather than wildcarded. Next calls
// loadEnvConfig() BEFORE it imports this file (see next/dist/server/config.js),
// and hosted builds put the same variable in the real environment, so
// NEXT_PUBLIC_SUPABASE_URL is readable here in both places. If it is missing or
// unparseable we fall back to the old "*.supabase.co" wildcard so a
// misconfigured environment degrades to the previous behavior instead of
// breaking every image and connection.
const SUPABASE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname;
  } catch {
    return "*.supabase.co";
  }
})();

// Content Security Policy, shipped REPORT-ONLY for now. It is deliberately a
// mirror of what the app actually loads today:
//   script-src  - every <script> in the app is inline (JSON-LD blocks on the
//                 guide/city/public pages plus the theme bootstrap in
//                 layout.tsx), and there is no third-party script tag anywhere:
//                 Stripe checkout is a server-side redirect, not stripe.js.
//                 'unsafe-eval' is what Next's dev bundler needs.
//   style-src   - Tailwind ships real stylesheets, but React inline styles and
//                 the CSS modules' runtime need 'unsafe-inline'.
//   img-src     - blob:/data: cover the local upload previews
//                 (URL.createObjectURL in the upload components), the Supabase
//                 host covers public Storage objects (pro logos).
//   object-src  - FilePreview.tsx renders a PDF thumbnail with
//                 <object data={blob:...}>, which default-src 'self' alone
//                 would flag.
//   connect-src - the browser talks to our own /api routes and to Supabase
//                 (auth + storage over https, realtime over wss). Every other
//                 outbound host (Gemini, Open-Meteo, RentCast, CSLB, Checkr,
//                 Resend, Twilio) is called from server code only.
//   font-src    - next/font/google self-hosts Inter at build time, so fonts
//                 come from our own origin.
// Report-only means violations are reported, never blocked. Graduate it to the
// enforcing "Content-Security-Policy" key after a burn-in period with no
// unexpected reports.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://${SUPABASE_HOST}`,
  "media-src 'self'",
  `connect-src 'self' https://${SUPABASE_HOST} wss://${SUPABASE_HOST}`,
  "font-src 'self'",
  "object-src 'self' blob:",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next dev` and `next build` corrupt each other when they share .next
  // (missing vendor chunks, prerender failures). Setting NEXT_DIST_DIR lets a
  // verification build write somewhere else while the dev server keeps
  // running. Hosted builds (e.g. Vercel) never set it, so they use .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  images: {
    // Supabase Storage public buckets serve images from your project domain.
    // Pinned to THIS project's host: a wildcard would let anyone's Supabase
    // project be proxied through our image optimizer.
    remotePatterns: [{ protocol: "https", hostname: SUPABASE_HOST }],
  },
  // Baseline security headers on every response. HSTS forces HTTPS, the frame
  // headers stop clickjacking, nosniff stops MIME confusion, and the referrer
  // policy keeps our URLs (which can contain ids) out of third-party referers.
  //
  // ORDERING, verified against Next 14's own router
  // (next/dist/server/lib/router-utils/resolve-routes.js): header routes do not
  // stop routing, so EVERY entry whose source matches contributes, and a later
  // entry setting the same key overwrites the earlier one (`resHeaders[key] =
  // value`; only set-cookie appends). That means a per-path entry can override
  // a global one, but it cannot UNSET a header - and X-Frame-Options has no
  // "allow any origin" value to override it with. So the frame header is
  // scoped by its source instead: the negative lookahead below simply never
  // matches the widget path.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value: [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; "),
          },
        ],
      },
      {
        // Everything except the embeddable widget stays DENY. Same rule as
        // before for every page; only the source changed.
        source: "/((?!api/pro-widget/).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        // The rating widget exists to be iframed by a pro's own website
        // (src/app/pro/profile/PublicPageCard.tsx hands them the <iframe>
        // snippet), so a blanket DENY made the one embeddable route
        // unembeddable. It serves aggregate-only public data, so any parent is
        // fine. No X-Frame-Options here at all - see the note above - and the
        // report-only policy is restated with the matching frame-ancestors so
        // legitimate embeds don't generate violation reports.
        source: "/api/pro-widget/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          {
            key: "Content-Security-Policy-Report-Only",
            value: [...CSP_DIRECTIVES, "frame-ancestors *"].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
