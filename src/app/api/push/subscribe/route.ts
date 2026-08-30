import { NextRequest, NextResponse } from "next/server";
import { sameOriginGuard } from "@/lib/csrf";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readJsonBounded } from "@/lib/boundedBody";
import { isMissingSchemaError } from "@/lib/dbErrors";

export const runtime = "nodejs";

// Register or remove ONE device for Web Push.
//
//   POST   { endpoint, keys: { p256dh, auth }, side? }  - upsert this device
//   DELETE { endpoint }                                 - forget this device
//
// Called by src/components/PushRegistrar.tsx (on every visit once permission is
// granted, so a reinstall or a VAPID key rotation heals itself) and by the
// "Turn on / Turn off notifications" button in src/components/PushSettingsCard.tsx.
//
// The row this writes is what src/lib/push.ts sends to. Nothing here talks to a
// push service; it only stores what the browser handed us.

// A PushSubscription endpoint is a URL at the browser vendor's push service,
// and the two keys are short base64url strings. Real values are well under
// these numbers; the caps exist so nobody can park kilobytes of arbitrary text
// in the table through an authenticated but hostile client.
const MAX_BODY_BYTES = 8_000;
const MAX_ENDPOINT_CHARS = 2_000;
const MAX_KEY_CHARS = 300;
const MAX_USER_AGENT_CHARS = 400;

// Only the three push services a real browser can hand back. This is the
// destination the server will later POST to, so it is an outbound-request
// target chosen by the client: without an allowlist, a signed-in account could
// store any URL it liked and turn every one of its own notifications into a
// server-side request to a host of its choosing (a classic SSRF shape).
// Prefix match on the ORIGIN, parsed rather than string-matched, so
// "https://fcm.googleapis.com.evil.test" cannot slip past.
const ALLOWED_PUSH_HOSTS = [
  // Chrome, Edge, Brave, Android WebView.
  "fcm.googleapis.com",
  "android.googleapis.com",
  // Safari, iOS and macOS. This is the one that matters for the iPhone.
  "web.push.apple.com",
  // Firefox.
  "updates.push.services.mozilla.com",
];

function isAllowedEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_PUSH_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
  );
}

// Per-process, per-user brake, same shape and reasoning as the outbound cap in
// src/lib/outboundGuards.ts: no database round trip in the hot path, and a
// serverless deployment runs several processes, so this is a blast-radius
// limiter rather than an exact quota. 30 in 5 minutes is far above real use
// (the registrar calls this at most once per page load) and well below anything
// that could fill the table.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 5 * 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();

function overRateLimit(userId: string, now = Date.now()): boolean {
  const current = hits.get(userId);
  if (!current || now >= current.resetAt) {
    // Opportunistic prune so a long-lived process does not accumulate one entry
    // per user who ever called this. Cheap: it only runs on a window rollover.
    if (hits.size > 5_000) {
      for (const [key, value] of hits) if (now >= value.resetAt) hits.delete(key);
    }
    hits.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export async function POST(req: NextRequest) {
  // CSRF, second lock. The session cookie is SameSite=Lax and this body is
  // JSON, so a cross-site page cannot get a signed-in request here today;
  // this refuses one outright rather than depending on those defaults.
  // src/lib/csrf.ts only rejects on positive cross-site evidence.
  const crossSite = sameOriginGuard(req);
  if (crossSite) return crossSite;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Authenticated here, not just in middleware: middleware redirects page
  // navigations and is explicitly not a security boundary (see the invariant at
  // the top of src/lib/supabase/middleware.ts).
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (overRateLimit(user.id)) {
    return NextResponse.json({ error: "Slow down." }, { status: 429 });
  }

  const parsed = await readJsonBounded(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.status === 413 ? "Too large." : "Bad request." },
      { status: parsed.status }
    );
  }
  const body = parsed.data;
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const endpoint = str(body.endpoint, MAX_ENDPOINT_CHARS);
  const p256dh = str(keys.p256dh, MAX_KEY_CHARS);
  const auth = str(keys.auth, MAX_KEY_CHARS);
  const side = body.side === "pro" ? "pro" : body.side === "homeowner" ? "homeowner" : null;

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Missing subscription." }, { status: 400 });
  }
  if (!isAllowedEndpoint(endpoint)) {
    return NextResponse.json(
      { error: "Unrecognized push service." },
      { status: 400 }
    );
  }

  const nowIso = new Date().toISOString();
  // Upsert on `endpoint` (unique, migration 0143): the same browser hands back
  // the same endpoint on every visit, so this is what keeps one device at one
  // row instead of one row per page load. user_id is written on every upsert on
  // purpose - a shared device where a second account signs in should move the
  // row, not leave notifications aimed at whoever registered it first.
  // Admin client for the write (the user is already authenticated above and
  // user_id is forced to that account): with the RLS client, ON CONFLICT on a
  // row that belongs to a previous account on the same device raises instead
  // of moving the row, so the second person on a shared phone got a 500
  // (2026-08-30 pre-push review, M1). Same endpoint can only ever belong to
  // one account, so overwriting user_id is the documented takeover.
  const { error } = await createAdminClient()
    .from("push_subscriptions")
    .upsert(
      {
        user_id: user.id,
        side,
        endpoint,
        p256dh,
        auth,
        user_agent: str(req.headers.get("user-agent"), MAX_USER_AGENT_CHARS),
        last_used_at: nowIso,
      },
      { onConflict: "endpoint" }
    );
  if (error) {
    if (isMissingSchemaError(error)) {
      // Migration 0143 has not been run against this database yet. Say so
      // plainly rather than pretending the device is registered.
      return NextResponse.json(
        { error: "Notifications are not set up on the server yet." },
        { status: 503 }
      );
    }
    console.error("push/subscribe: upsert failed:", error.message ?? error);
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }

  // Turning it on is explicit consent, so it clears any earlier opt-out. Merged
  // into the existing jsonb rather than replacing it: notification_prefs also
  // carries the channel toggles and the CAN-SPAM email opt-out, and a blind
  // overwrite here would silently re-subscribe someone to email.
  await setPushOptOut(supabase, user.id, false);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  // CSRF, second lock. The session cookie is SameSite=Lax and this body is
  // JSON, so a cross-site page cannot get a signed-in request here today;
  // this refuses one outright rather than depending on those defaults.
  // src/lib/csrf.ts only rejects on positive cross-site evidence.
  const crossSite = sameOriginGuard(req);
  if (crossSite) return crossSite;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (overRateLimit(user.id)) {
    return NextResponse.json({ error: "Slow down." }, { status: 429 });
  }

  const parsed = await readJsonBounded(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.status === 413 ? "Too large." : "Bad request." },
      { status: parsed.status }
    );
  }
  const endpoint = str(parsed.data.endpoint, MAX_ENDPOINT_CHARS);
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint." }, { status: 400 });
  }

  // .eq("user_id") as well as .eq("endpoint"): RLS already scopes the delete to
  // this account, but the ownership check belongs in the query too. Never trust
  // an id that arrived from a browser (see the IDOR rule).
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", user.id);
  if (error && !isMissingSchemaError(error)) {
    console.error("push/subscribe: delete failed:", error.message ?? error);
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }

  // Turning notifications off on your LAST device means "stop pushing me", and
  // that has to survive the device: without the flag, the next visit's
  // registrar would silently re-subscribe the browser it was just switched off
  // in. With more than one device left, this was a per-device change and the
  // account-wide preference is left alone.
  const { count } = await supabase
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((count ?? 0) === 0) {
    await setPushOptOut(supabase, user.id, true);
  }

  return NextResponse.json({ ok: true });
}

// Read-modify-write of the one jsonb column that holds every notification
// preference. Best effort: a failure here leaves the subscription rows correct,
// which is what actually decides whether a push goes out today.
async function setPushOptOut(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  optOut: boolean
): Promise<void> {
  try {
    const { data: current } = await supabase
      .from("users")
      .select("notification_prefs")
      .eq("id", userId)
      .single();
    const prefs = { ...(current?.notification_prefs ?? {}), push_opt_out: optOut };
    await supabase.from("users").update({ notification_prefs: prefs }).eq("id", userId);
  } catch {
    // Nothing to do - see the comment above.
  }
}
