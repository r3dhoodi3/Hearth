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
  // How much of a request body Next will hand to middleware before it gives
  // up on the rest. Default 10MB, and it TRUNCATES rather than rejecting.
  //
  // WHY THIS IS HERE. src/middleware.ts matches everything except _next and
  // the two public asset folders, so it runs on /api/* too. Next only clones a
  // request body when middleware is in play, and that clone is where the limit
  // lives (next/dist/server/body-streams.js: getCloneableBody takes the size
  // limit from experimental.middlewareClientMaxBodySize, and past it logs
  // "Request body exceeded 10MB ... Only the first 10MB will be available
  // unless configured" and closes BOTH streams, the middleware's copy and the
  // one the route handler goes on to read). So the route does not get a 413 or
  // an error: it gets a truncated body. For /api/ingest-inspection that means
  // a 20MB inspection PDF (~26.7MB once base64'd into JSON, which is why the
  // route's own MAX_BODY_BYTES is 26MB) arrives cut off mid-string, JSON.parse
  // fails, and the owner is told their upload was a bad request - for a file
  // that was exactly the size the page told them to send.
  //
  // 30mb, not 26: it has to clear the route's own ceiling plus the JSON
  // envelope around the base64, and this value is only ever an upper bound on
  // what may be buffered. The real per-route caps do the actual limiting, and
  // they are unchanged - readJsonBounded still cancels the read the moment a
  // body passes MAX_BODY_BYTES, so raising this does not widen what any route
  // will accept, it only stops Next from silently corrupting a body the route
  // was always going to bound itself.
  //
  // Still experimental in Next 15.5 (config-schema.js), hence the nesting.
  experimental: {
    middlewareClientMaxBodySize: "30mb",
  },
  images: {
    // Supabase Storage public buckets serve images from your project domain.
    // Pinned to THIS project's host: a wildcard would let anyone's Supabase
    // project be proxied through our image optimizer.
    remotePatterns: [{ protocol: "https", hostname: SUPABASE_HOST }],
  },
  // Route moves, answered by the router BEFORE any React rendering happens.
  // That is the whole point of putting them here rather than in a page.
  // /profile used to be a one-line `redirect("/dashboard#systems")` page
  // component, which sounds free but is not: it lives inside the (app) route
  // group, so reaching that one line meant Next first rendered the group's
  // layout, and that layout runs several queries (active property, the homes
  // list, the profile row, the auth user, the Plus check) before the page
  // function is ever called. All of it work done purely to throw the response
  // away and redirect. Answering here costs a response header.
  //
  // permanent: false (a 307, not a 308): this is a product decision about
  // where Home Profile lives, not an immutable URL move, and a 308 gets cached
  // by browsers indefinitely, which would make it very hard to walk back.
  //
  // The #systems fragment survives. Next writes the destination into the
  // Location header verbatim and browsers apply a fragment from a redirect
  // target, so an old bookmark still lands on the systems section rather than
  // the top of the dashboard. In-app links were repointed straight at
  // /dashboard#systems so a click never pays even this hop; the entry is here
  // for external links and bookmarks.
  async redirects() {
    return [
      {
        source: "/profile",
        destination: "/dashboard#systems",
        permanent: false,
      },
    ];
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
