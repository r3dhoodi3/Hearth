import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route probes through the service-role client, which imports "server-only"
// and is unresolvable under vitest - mocked with a factory the same way the
// Stripe webhook and cron route tests do it. `probeResult` is what the mocked
// query resolves to, and `probeDelayMs` lets a test hang the query long enough
// for the 3s abort to fire.

let probeResult: { error: unknown } = { error: null };
let probeDelayMs = 0;
// The relation the route asked for, so a test can pin the probe to a table the
// service role can actually read.
let probedTable: string | null = null;
let adminClientCalls = 0;
// The abort signal the route handed to the query, so a test can assert the
// timeout actually reaches the request instead of just racing beside it.
let lastSignal: AbortSignal | null = null;
// The IP limiter: what rate_limit_hit answers (false = over the limit, null =
// the limiter itself is broken), and the arguments it was called with.
let rateLimitAllows: boolean | null = true;
let rateLimitCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminClientCalls += 1;
    return {
      rpc(fn: string, args: Record<string, unknown>) {
        rateLimitCalls.push({ fn, args });
        return {
          abortSignal: () => Promise.resolve({ data: rateLimitAllows }),
        };
      },
      from(table: string) {
        probedTable = table;
        const api: Record<string, unknown> = {};
        Object.assign(api, {
          select: () => api,
          limit: () => api,
          abortSignal: (signal: AbortSignal) => {
            lastSignal = signal;
            if (probeDelayMs <= 0) return Promise.resolve(probeResult);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(probeResult), probeDelayMs);
              signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
              });
            });
          },
        });
        return api;
      },
    };
  },
}));

const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGINAL_SHA = process.env.VERCEL_GIT_COMMIT_SHA;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// A monitor's GET. The route reads one header off it (x-forwarded-for, for the
// per-IP limiter) and nothing else.
function request(ip?: string) {
  return new Request("https://gethearth.app/api/health", {
    headers: ip ? { "x-forwarded-for": ip } : {},
  });
}

beforeEach(() => {
  probeResult = { error: null };
  probeDelayMs = 0;
  probedTable = null;
  adminClientCalls = 0;
  lastSignal = null;
  rateLimitAllows = true;
  rateLimitCalls = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-value";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restore("NEXT_PUBLIC_SUPABASE_URL", ORIGINAL_URL);
  restore("SUPABASE_SERVICE_ROLE_KEY", ORIGINAL_KEY);
  restore("VERCEL_GIT_COMMIT_SHA", ORIGINAL_SHA);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a healthy database", () => {
  it("answers 200 with db:ok, a latency number, and the deploy version", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    const { GET } = await import("./route");

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    // Short SHA, not the full one, and never the raw env var.
    expect(body.version).toBe("abcdef1");
  });

  it("reports version 'dev' off Vercel rather than inventing one", async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const { GET } = await import("./route");
    expect((await (await GET(request())).json()).version).toBe("dev");
  });

  it("treats an empty result set as healthy", async () => {
    // A brand-new database with no rows is a perfectly healthy database; only
    // an error means the chain is broken.
    probeResult = { error: null };
    const { GET } = await import("./route");
    expect((await GET(request())).status).toBe(200);
  });

  it("probes a relation the probing role can actually read", async () => {
    // THE BUG THIS GUARDS. The first version read `lead_previews` on the anon
    // key, on the strength of 0006's `grant select ... to anon`. That grant is
    // not in force on the live database - anon gets 42501, "permission denied
    // for view lead_previews" - so the endpoint answered 503 on a perfectly
    // healthy database, which is worse than having no monitor at all. The
    // probe now goes through the service-role client, which is guaranteed to
    // be able to read, against the oldest table in the schema.
    const { GET } = await import("./route");
    await GET(request());
    // Two service-role clients now: the per-IP limiter, then the probe.
    expect(adminClientCalls).toBe(2);
    expect(probedTable).toBe("users");
  });

  it("is never cacheable and never indexed", async () => {
    const { GET } = await import("./route");
    const res = await GET(request());
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

describe("the per-IP limit on a public, service-role endpoint", () => {
  it("meters each caller separately, on the first x-forwarded-for hop", async () => {
    // WHY THIS EXISTS. The probe runs on the SERVICE-ROLE key - the one
    // credential with no RLS ceiling - and the response is uncacheable by
    // design, so an unthrottled public route turns anonymous traffic into
    // privileged database load. The anon-key probe this replaced had that
    // bound for free; this is what puts it back.
    const { GET } = await import("./route");
    await GET(request("203.0.113.7, 70.41.3.18"));

    const limiter = rateLimitCalls.find((c) => c.fn === "rate_limit_hit");
    expect(limiter).toBeDefined();
    // Later hops are attacker-supplied, so only the first one counts.
    expect(limiter!.args.p_bucket).toBe("health:203.0.113.7");
    expect(limiter!.args.p_limit).toBe(30);
    expect(limiter!.args.p_window_seconds).toBe(60);
  });

  it("buckets a header-less request rather than giving it a free lane", async () => {
    const { GET } = await import("./route");
    await GET(request());
    expect(rateLimitCalls[0].args.p_bucket).toBe("health:unknown");
  });

  it("429s with an EMPTY body once a caller is over the limit", async () => {
    rateLimitAllows = false;
    const { GET } = await import("./route");

    const res = await GET(request("203.0.113.7"));

    expect(res.status).toBe(429);
    // Not the health JSON: it would report a database state this request never
    // checked. Not a reason string either - the response still gives nothing
    // away.
    expect(await res.text()).toBe("");
    // And nothing privileged was spent on it.
    expect(probedTable).toBeNull();
  });

  it("keeps a throttled response uncacheable and unindexed too", async () => {
    rateLimitAllows = false;
    const { GET } = await import("./route");
    const res = await GET(request("203.0.113.7"));
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("still answers when the limiter itself cannot", async () => {
    // Fail open. A broken limiter means the database is in trouble, which is
    // exactly when a monitor most needs a reply.
    rateLimitAllows = null;
    const { GET } = await import("./route");
    expect((await GET(request("203.0.113.7"))).status).toBe(200);
  });

  it("does not try to meter a deployment with no Supabase config", async () => {
    // createAdminClient asserts its env vars, so the limiter cannot run before
    // the unconfigured check - it would throw instead of answering 503.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await import("./route");
    expect((await GET(request())).status).toBe(503);
    expect(rateLimitCalls).toHaveLength(0);
    expect(adminClientCalls).toBe(0);
  });
});

describe("a failing database", () => {
  it("answers 503 with db:error so a monitor actually alerts", async () => {
    // THE POINT OF THE STATUS CODE. A 200 carrying {"ok":false} is the alert
    // that never fires, because every uptime monitor decides on the code.
    probeResult = {
      error: { message: 'relation "public.users" does not exist' },
    };
    const { GET } = await import("./route");

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.db).toBe("error");
  });

  it("leaks nothing beyond the category - no message, no env, no host", async () => {
    // The probe now runs on the service role, so the key must be doubly
    // certain never to reach the body of a route anyone can curl.
    probeResult = {
      error: {
        message: 'permission denied for relation users at project.supabase.co',
      },
    };
    const { GET } = await import("./route");

    const raw = await (await GET(request())).text();

    expect(raw).not.toContain("permission denied");
    expect(raw).not.toContain("supabase.co");
    expect(raw).not.toContain("service-role-key-value");
    // The whole body is the four documented keys and nothing else.
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "db",
      "latencyMs",
      "ok",
      "version",
    ]);
  });

  it("503s when Supabase is not configured at all, without naming the vars", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { GET } = await import("./route");

    const res = await GET(request());
    const raw = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(raw).db).toBe("error");
    expect(raw).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
    // Checked BEFORE the client is built: createAdminClient asserts both env
    // vars non-null, so an unconfigured deployment would otherwise throw
    // inside the constructor instead of answering.
    expect(adminClientCalls).toBe(0);
  });

  it("503s when the service-role key is missing, without naming it", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await import("./route");

    const res = await GET(request());
    const raw = await res.text();

    expect(res.status).toBe(503);
    expect(raw).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(adminClientCalls).toBe(0);
  });

  it("gives up at the 3s ceiling instead of hanging the monitor", async () => {
    // A check that cannot finish is a failure with none of the signal of a
    // real one, so it must not be left to the platform's function timeout.
    // Fake timers drive the route's own 3s abort, so this exercises the real
    // AbortController rather than simulating a timeout beside it.
    vi.useFakeTimers();
    probeDelayMs = 60_000;
    const { GET } = await import("./route");

    const pending = GET(request());
    // Let the route reach the awaited query and arm its signal.
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSignal).not.toBeNull();
    expect(lastSignal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;

    expect(lastSignal!.aborted).toBe(true);
    expect(res.status).toBe(503);
    expect((await res.json()).db).toBe("error");
  });
});
