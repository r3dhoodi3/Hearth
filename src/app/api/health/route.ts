import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIpFromHeaders } from "@/lib/clientIp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness + readiness probe for an external monitor (UptimeRobot, Checkly,
// Vercel's own checks). Pinging "/" only proves the edge is up; this proves the
// database behind it answers, which is the failure this endpoint exists for: a
// paused/over-quota Supabase project, a wedged PostgREST, or an unreachable
// host, while Next keeps happily serving cached HTML. Everything on the
// signed-in side is dead in that state and nothing else in the app would say
// so. (It does NOT catch a revoked anon key: the probe runs on the service-role
// client, for the reason set out above PROBE_RELATION. The signed-in app would
// be broken and this endpoint would still answer 200. That is the price of the
// probe being able to read anything at all, and it is worth naming here so
// nobody reads a green check as more than it is.)
//
// UNAUTHENTICATED ON PURPOSE, so it must give away nothing. Three rules hold
// the response down:
//
//   1. The probe reads ONE column of ONE row and throws the row away. Nothing
//      it reads is ever serialized, so what the query can see is irrelevant to
//      what the caller can see.
//   2. `db` is a two-value category ("ok" / "error"). The reason a query failed
//      goes to the server log, never into the body: a PostgREST error string
//      carries table and column names, and a fetch failure carries the project
//      hostname.
//   3. No env var, no key, no connection string, no stack is ever serialized.
//      `version` is the deploy's git SHA, which is already public on any repo
//      this deploys from and is the one thing a monitor genuinely needs in
//      order to say "the bad deploy is still live".
//
// Middleware: /api/health is named in isPublicPath (src/lib/supabase/middleware.ts)
// because "api" is a guarded segment. Without that entry every probe would be
// 307'd to /signin, and a monitor following the redirect would score an HTML
// sign-in page as a healthy 200 while the database was on fire.

// Hard ceiling on the DB work in one request, shared by the limiter and the
// probe. A monitor treats a slow response the same as a hung one but with none
// of the signal, so a check that cannot finish in three seconds is reported as
// a failure rather than left to hang until the platform's own function timeout
// kills it.
const DB_TIMEOUT_MS = 3000;

// Per-IP ceiling, because this route is public, uncacheable by design, and
// spends a SERVICE-ROLE database round trip on every hit. Without a bound that
// is an amplifier: anonymous requests driving privileged load on the one
// credential with no RLS ceiling, which is exactly the bound the original
// anon-key probe was there to provide. 30/minute is roughly one hit every two
// seconds, far above what any real monitor schedules (the tightest sane check
// interval is 30s) and far below anything that hurts.
//
// Over the limit answers 429 with an EMPTY body: not the health JSON, which
// would tell a monitor the database was fine when this request never asked,
// and not a reason string either, since the response must keep giving nothing
// away.
const HEALTH_HITS_PER_MINUTE = 30;
const RATE_WINDOW_SECONDS = 60;

// The probe reads one id off `users` (migration 0001, the oldest table there
// is) and discards it. `limit(1)` means Postgres stops at the first row, and
// nothing read is ever returned to the caller: the probe reports that the query
// answered, never what it answered. An empty table is still a healthy answer.
//
// WHY THE SERVICE-ROLE CLIENT AND NOT THE ANON KEY. The first version of this
// probed `lead_previews` on the anon key, because that view is the one relation
// with an explicit `grant select ... to anon`. On the live database that grant
// is not in force - the anon role gets 42501, "permission denied for view
// lead_previews" (0119 tightened the default privileges the view was relying
// on, and 0123 revoked public browse access), so the endpoint answered 503 on a
// perfectly healthy database. A monitor that cries wolf every five minutes is
// worse than no monitor, so the probe now uses the client that is guaranteed to
// be able to read: createAdminClient, which is `server-only` and whose key
// never leaves the process. That does mean this public route triggers one
// service-role read per hit - it is a single indexed `limit 1` with no filter
// and no user input anywhere near it, and the result is reduced to a boolean
// before it can be serialized, so there is nothing to steer and nothing to
// read back.
const PROBE_RELATION = "users";

type DbResult = { ok: boolean; reason: string };

// createAdminClient asserts both of these non-null, so a deployment missing
// either would throw inside the client constructor rather than answer.
function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// The trusted client IP (src/lib/clientIp.ts): Vercel's own header, else the
// LAST x-forwarded-for hop. The old first-hop read was spoofable - a client
// could send its own X-Forwarded-For and mint a fresh bucket per request,
// which mattered most here because this endpoint runs on the service-role key.
// A request with no usable header shares the "unknown" bucket, the correct
// pessimistic answer: a local call or a header-stripping proxy, neither of
// which should get an unlimited lane.
function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers) ?? "unknown";
}

// FAILS OPEN, like every other rate_limit_hit call in this codebase: if the
// limiter cannot answer, the database is in trouble, which is precisely when a
// monitor most needs this endpoint to reply.
async function withinIpLimit(
  req: Request,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const { data } = await createAdminClient()
      .rpc("rate_limit_hit", {
        p_bucket: `health:${clientIp(req)}`,
        p_limit: HEALTH_HITS_PER_MINUTE,
        p_window_seconds: RATE_WINDOW_SECONDS,
      })
      .abortSignal(signal);
    return data !== false;
  } catch {
    return true;
  }
}

async function checkDb(controller: AbortController): Promise<DbResult> {
  // A deployment with no Supabase config cannot serve a single signed-in page,
  // so it is unhealthy, not "unknown". Reported as a plain category; the names
  // of the missing variables stay in the log line.
  if (!supabaseConfigured()) {
    console.error("health: Supabase URL / service-role key missing from the environment");
    return { ok: false, reason: "unconfigured" };
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from(PROBE_RELATION)
      .select("id")
      .limit(1)
      .abortSignal(controller.signal);
    if (error) {
      // The message can name tables and columns, so it is logged and dropped,
      // never returned. An empty result set is NOT an error - a brand-new
      // database with no rows in it is a perfectly healthy database.
      console.error("health: db probe failed:", error.message ?? error);
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "query" };
    }
    return { ok: true, reason: "ok" };
  } catch (err) {
    // AbortError included: `aborted` distinguishes "we gave up at 3s" from
    // "the host did not resolve", which is the one distinction worth having
    // at 3am.
    if (controller.signal.aborted) {
      console.error("health: db probe timed out after", DB_TIMEOUT_MS, "ms");
      return { ok: false, reason: "timeout" };
    }
    console.error("health: db probe threw:", err);
    return { ok: false, reason: "unreachable" };
  }
}

// The running deploy, short SHA. Vercel injects VERCEL_GIT_COMMIT_SHA on every
// build; locally there is none, so "dev" is the honest answer rather than an
// invented version number.
function deployVersion(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return sha ? sha.slice(0, 7) : "dev";
}

// Shared by every response this route can give, 429 included: a throttled hit
// must be no more cacheable and no more indexable than a real answer.
const RESPONSE_HEADERS: Record<string, string> = {
  // Nothing about this response may ever be served from a cache - a cached 200
  // is a monitor that cannot see an outage.
  "Cache-Control": "no-store, no-cache, must-revalidate",
  // It is a machine endpoint, not a page; keep it out of search results even
  // though nothing links to it.
  "X-Robots-Tag": "noindex",
};

export async function GET(req: Request) {
  const startedAt = Date.now();
  // ONE deadline for the whole request, shared by the limiter and the probe, so
  // the 3s ceiling is a property of the response rather than of one query.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    // Skipped when there is nothing to talk to: checkDb answers 503
    // "unconfigured" a line later, and createAdminClient would throw here.
    if (supabaseConfigured() && !(await withinIpLimit(req, controller.signal))) {
      // Empty body on purpose. The health JSON would claim a database state
      // this request never checked, and a reason string would be one more
      // thing to read.
      return new NextResponse(null, { status: 429, headers: RESPONSE_HEADERS });
    }

    const db = await checkDb(controller);
    const latencyMs = Date.now() - startedAt;

    return NextResponse.json(
      {
        ok: db.ok,
        db: db.ok ? "ok" : "error",
        latencyMs,
        version: deployVersion(),
      },
      {
        // 503 on a failed check: a monitor decides on the status code, and a
        // 200 carrying {"ok":false} is exactly the alert that never fires.
        status: db.ok ? 200 : 503,
        headers: RESPONSE_HEADERS,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}
