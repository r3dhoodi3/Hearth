import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Embeddable rating widget: GET /api/pro-widget/<contractor_id> returns a
// small self-contained HTML page meant for a 320x120 iframe on a pro's own
// website. Anon-safe: it uses the plain anon key (no cookies, no session) and
// only ever reads the same public_pro_profile RPC (0033) that powers the
// public /p/<id> page.
//
// COMPLIANCE (FTC consumer review rules): this widget is strictly read-only
// presentation of the pro's TRUE aggregate: the overall rating and the total
// review count across ALL of their Hearth reviews, exactly as computed
// everywhere else. No cherry-picking: it must never show a filtered,
// reordered, or otherwise flattering subset, and nothing here touches the
// rating math or ordering.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!
  );
}

// Shared shell: tiny, dependency-free, inline styles only, so the iframe
// renders identically on any host page.
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  html,body{margin:0;padding:0;background:transparent}
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
  .w{box-sizing:border-box;height:120px;max-width:320px;padding:14px 16px;
     border:1px solid #e7e5e4;border-radius:12px;background:#fff;
     display:flex;flex-direction:column;justify-content:center;gap:3px;overflow:hidden}
  .n{font-size:13px;font-weight:600;color:#1c1917;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row{display:flex;align-items:baseline;gap:6px;white-space:nowrap}
  .s{font-size:16px;letter-spacing:1px}
  .on{color:#f59e0b}
  .off{color:#d6d3d1}
  .r{font-size:13px;font-weight:600;color:#44403c;font-variant-numeric:tabular-nums}
  .c{font-size:12px;color:#78716c}
  .m{font-size:12px;color:#78716c}
  a{font-size:12px;font-weight:500;color:#b45309;text-decoration:none}
  a:hover{text-decoration:underline}
</style>
</head>
<body><div class="w">${body}</div></body>
</html>`;
}

function htmlResponse(markup: string, status = 200): NextResponse {
  return new NextResponse(markup, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The aggregate moves slowly; an hour of caching keeps embeds cheap.
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const id = params.id;

  // LOW-50: this route is public, unauthenticated, and CDN-cached per id -
  // but the id in the URL is a random UUID a caller fully controls, so a loop
  // over fresh UUIDs is a cache miss every single time and spends one
  // public_pro_profile RPC per request, same shape as invite-card's abuse
  // case (see src/app/api/invite-card/[code]/route.tsx, mirrored here). IP,
  // fixed-window, checked before any lookup so a blocked caller costs
  // nothing. Fails open on an RPC hiccup - only an explicit `allowed ===
  // false` blocks - so a limiter outage never breaks a widget actually
  // embedded on a pro's site. Same 30-per-5-minutes budget as invite-card:
  // generous next to what one embedded widget's real traffic needs.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  try {
    const rlAdmin = createAdminClient();
    const { data: allowed } = await rlAdmin.rpc("rate_limit_hit", {
      p_bucket: `prowidget:${ip ?? "unknown"}`,
      p_limit: 30,
      p_window_seconds: 300,
    });
    if (allowed === false) {
      return new NextResponse("Too many requests", { status: 429 });
    }
  } catch (err) {
    // FAIL OPEN: nothing here is billed or destructive, and a real embed on a
    // pro's own site must not go blank over a limiter hiccup.
    console.error("pro-widget rate_limit_hit failed - allowing:", err);
  }

  if (!UUID_RE.test(id)) {
    return htmlResponse(
      shell("Not found", `<p class="m">This Hearth widget link is invalid.</p>`),
      404
    );
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? req.nextUrl.origin;
  const pageUrl = `${site}/p/${id}`;

  // Plain anon client: no cookie store, so this route stays session-free and
  // safely cacheable. The RPC is the public read path; RLS/SECURITY DEFINER
  // on the database side decides what it exposes.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Cast: the generated types don't know this RPC (database.types.ts is not
  // regenerated here).
  const { data, error } = await (supabase.rpc as any)("public_pro_profile", {
    p_contractor: id,
  });

  // Migration 0033 not applied yet (missing function) must degrade to a soft
  // placeholder, never a crash or a scary error inside someone's website.
  if (error) {
    return htmlResponse(
      shell(
        "Reviews on Hearth",
        `<p class="n">Reviews on Hearth</p>
         <p class="m">This widget is being set up. Check back soon.</p>
         <a href="${esc(site)}" target="_blank" rel="noopener">Hearth</a>`
      )
    );
  }

  const profile = data as {
    name: string;
    rating: number | null;
    review_count: number;
  } | null;

  if (!profile) {
    return htmlResponse(
      shell("Not found", `<p class="m">This Hearth widget link is invalid.</p>`),
      404
    );
  }

  const name = esc(profile.name);
  const count = profile.review_count ?? 0;
  const hasRating = count > 0 && profile.rating != null;

  let body: string;
  if (hasRating) {
    // Star glyphs for the full aggregate (rounded for display only; the exact
    // number is printed right next to them).
    const full = Math.min(5, Math.max(0, Math.round(profile.rating!)));
    const stars =
      `<span class="on">${"★".repeat(full)}</span>` +
      `<span class="off">${"★".repeat(5 - full)}</span>`;
    body = `<p class="n">${name}</p>
<div class="row"><span class="s">${stars}</span><span class="r">${profile.rating}</span><span class="c">${count} review${count === 1 ? "" : "s"}</span></div>
<a href="${esc(pageUrl)}" target="_blank" rel="noopener">See all reviews on Hearth</a>`;
  } else {
    // Honest empty state: no reviews yet, say so.
    body = `<p class="n">${name}</p>
<p class="m">No reviews yet. Reviews come from real Hearth jobs only.</p>
<a href="${esc(pageUrl)}" target="_blank" rel="noopener">See ${name} on Hearth</a>`;
  }

  return htmlResponse(shell(`${profile.name} on Hearth`, body));
}
