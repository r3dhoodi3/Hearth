// The one place that decides "what IP is this request from" for every
// rate-limit and risk-signal key in the app. It exists because the obvious
// version is wrong on Vercel and was quietly spoofable everywhere it was
// copy-pasted.
//
// THE TRAP: `x-forwarded-for.split(",")[0]` reads the FIRST hop, and on Vercel
// the first hop is attacker-supplied. A client can send its own
// `X-Forwarded-For: 9.9.9.9` header; Vercel's edge does not strip it, it
// APPENDS the real client IP after it. So the chain arrives as
// `9.9.9.9, <real client ip>` and taking [0] hands the caller a value they
// chose. Every per-IP bucket then gets a fresh key per request and the cap
// never trips: spam limits, card-scrape limits, the /api/health service-role
// probe budget, and the IP-based multi-account risk signal all defeated by one
// header.
//
// THE FIX, in order of trust:
//   1. `x-vercel-forwarded-for` - set by Vercel's edge from the connection it
//      actually terminated, and NOT copied from any client header. This is the
//      real client IP on Vercel and the value to trust when present.
//   2. The LAST hop of `x-forwarded-for` - the entry Vercel itself appended,
//      after any client-supplied hops. Trustworthy only because everything to
//      its left is untrusted; the rightmost hop is the one the platform saw.
//      (This is the correct read on any single-trusted-proxy setup, not just
//      Vercel.)
//   3. `x-real-ip` - a last resort some proxies set to the single client IP.
//
// Returns null when nothing usable is present (local dev, an odd runtime), and
// callers already treat a null IP as "no IP bucket for this request", which is
// the safe direction: a missing IP never invents a shared bucket.
//
// If Hearth ever moves off Vercel, step 1's header name is the only thing that
// changes; steps 2 and 3 are generic.
export function clientIpFromHeaders(
  h: Pick<Headers, "get">
): string | null {
  const vercel = h.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel;

  const xff = h.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    // The last hop is the one the trusted edge appended; earlier hops are
    // whatever the client chose to send.
    const last = hops[hops.length - 1];
    if (last) return last;
  }

  const real = h.get("x-real-ip")?.trim();
  if (real) return real;

  return null;
}
