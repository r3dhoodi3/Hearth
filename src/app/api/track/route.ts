import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import type { Json } from "@/lib/database.types";

export const runtime = "nodejs";

// Cap the raw body we'll even look at, so a caller can't DoS this endpoint
// (or the log/table) with an unbounded payload.
const MAX_BODY_CHARS = 2048;
// props is stored as jsonb; keep the serialized size sane independent of the
// overall body cap above (a single giant prop blob would still fit under
// MAX_BODY_CHARS otherwise).
const MAX_PROPS_CHARS = 1024;

// Every event name this PUBLIC route is allowed to insert on a caller's say-so.
// Unlisted names are dropped (logged, not inserted) rather than erroring, so a
// typo'd or removed event on the client can never break the beacon. Add a
// name here whenever a new client-side track() call site is wired up.
//
// Server-only events NEVER belong in this set: pro_apply, job_won, post_job,
// and choose_applicant are written straight into app_events by
// trackServerEvent (src/app/pro/actions.ts, src/app/(app)/contractors/actions.ts),
// never through this route. Anyone can POST to a public route, so accepting
// those names here would let a visitor forge server-only analytics (e.g. a
// fake job_won) - comment only, not code, on purpose.
const CLIENT_ALLOWED_EVENTS = new Set([
  "post_job_from_chat", // AskHearth.tsx
  "hero_demo_play", // HeroDemoPlayer.tsx
  "signup_homeowner", // homeowner-signup/page.tsx
]);

// Sink for src/lib/analytics.ts's track(). Inserts into app_events with the
// service-role client (no anon/authenticated RLS policy exists for this
// table on purpose, see migration 0091), and degrades gracefully to a log
// line if the table hasn't been migrated onto the live DB yet. Never fails
// the caller: analytics must never be able to break the app.
export async function POST(req: NextRequest) {
  try {
    // Unauthenticated and public, so it needs its own throttle before doing
    // any real work: keyed on IP (same derivation as
    // src/app/(auth)/recordTermsAcceptance.ts), fixed-window via the shared
    // rate_limit_hit RPC (migration 0068). Fails open on an RPC hiccup - only
    // an explicit `allowed === false` skips the insert - and returns 200
    // either way: analytics must never error the caller's beacon.
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const admin = createAdminClient();
    const { data: allowed } = await admin.rpc("rate_limit_hit", {
      p_bucket: `track:${ip ?? "unknown"}`,
      p_limit: 60,
      p_window_seconds: 300,
    });
    if (allowed === false) {
      return NextResponse.json({ ok: true });
    }

    const body = await req.text();
    if (body.length > MAX_BODY_CHARS) {
      // Log only the size, NEVER the raw payload: this runs before JSON.parse
      // and before the event allowlist, so the body is fully untrusted caller
      // input that could carry anything, and Vercel logs are third-party
      // retention. The length alone is enough to spot an abusive caller.
      console.log("[track] dropped oversized body", body.length);
      return NextResponse.json({ ok: true });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return NextResponse.json({ ok: true });
    }
    const { event, props } = (parsed ?? {}) as {
      event?: unknown;
      props?: unknown;
    };
    if (typeof event !== "string" || !CLIENT_ALLOWED_EVENTS.has(event)) {
      // Not a hard error: an old client build or a removed event name should
      // just be dropped, not surfaced to the visitor.
      return NextResponse.json({ ok: true });
    }

    let propsJson: Json | null = null;
    if (props && typeof props === "object") {
      const serialized = JSON.stringify(props);
      propsJson =
        serialized.length <= MAX_PROPS_CHARS
          ? (JSON.parse(serialized) as Json)
          : null; // oversized props are dropped, not truncated mid-JSON
    }

    // Best-effort user id: sendBeacon carries same-origin cookies, but a
    // signed-out visitor (or a beacon that lands after sign-out) is a normal
    // case, not an error.
    let userId: string | null = null;
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      userId = user?.id ?? null;
    } catch {
      /* stay anonymous rather than fail the beacon over an auth hiccup */
    }

    const { error } = await admin.from("app_events").insert({
      event,
      props: propsJson,
      user_id: userId,
    });
    if (error && !isMissingSchemaError(error)) {
      console.error("track: insert failed:", error.message ?? error);
    } else if (error) {
      // app_events migration (0091) hasn't run on this DB yet: log instead
      // of dropping the event silently, same graceful-degrade pattern used
      // elsewhere for not-yet-migrated tables.
      console.log("[track]", event, propsJson ?? {});
    }
  } catch {
    /* ignore - never fail the client over analytics */
  }
  return NextResponse.json({ ok: true });
}
