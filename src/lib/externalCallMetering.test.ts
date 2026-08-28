import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Two outbound third-party calls that a signed-in account could make Hearth
// repeat without limit: the lazy ownership re-check on a job post (RentCast,
// billed per call) and the address autocomplete (Photon, a free community
// service that can only defend itself by blocking our egress IPs).

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ---------------------------------------------------------------------------
// The lazy ownership re-check on job post.
//
// src/app/(app)/contractors/actions.ts is a "use server" module that pulls in
// next/cache, next/navigation and the service-role client, so this is asserted
// against its source, the same way src/lib/parcel.test.ts checks it.
// ---------------------------------------------------------------------------

describe("the lazy ownership re-check is metered", () => {
  const contractors = src("../app/(app)/contractors/actions.ts");
  const lazy = contractors.slice(
    contractors.indexOf("Lazy ownership check (migration 0093)")
  );

  it("spends the same parcel buckets onboarding's lookups spend", () => {
    // THE GAP. When the records source is unreachable, the check deliberately
    // records NOTHING so it stays eligible to run again - which means that
    // during a RentCast outage EVERY job post from this account re-ran the
    // billed lookup, up to the 20-a-day post cap, with nothing counting it.
    expect(lazy).toContain("parcel:${user.id}");
    expect(lazy).toContain("parcel-day:${user.id}");
    expect(lazy).toContain("p_limit: 10");
    expect(lazy).toContain("p_limit: 25");
  });

  it("puts the limiter in FRONT of the lookup", () => {
    const limiter = lazy.indexOf("parcel:${user.id}");
    const lookup = lazy.indexOf("await lookupParcel(");
    expect(limiter).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(lookup);
  });

  it("blocks the LOOKUP, never the post", () => {
    // A refused lookup leaves ownership unchecked, which is exactly the state a
    // failed lookup leaves it in. The homeowner's job still posts.
    const refusal = lazy.slice(
      lazy.indexOf("if (allowedParcelHour === false || allowedParcelDay === false)"),
      lazy.indexOf("} else {", lazy.indexOf("allowedParcelDay === false"))
    );
    expect(refusal).toContain("console.warn");
    expect(refusal).not.toContain("redirect(");
    expect(refusal).not.toContain("setFlash");
  });

  it("still fails open on a limiter hiccup", () => {
    // Only an explicit `false` blocks; a null/undefined from a DB blip does
    // not, matching every other rate_limit_hit call in the file.
    expect(lazy).toContain("allowedParcelHour === false");
    expect(lazy).toContain("allowedParcelDay === false");
  });
});

// ---------------------------------------------------------------------------
// The address autocomplete's owner-wide ceiling, driven for real.
// ---------------------------------------------------------------------------

let signedIn = true;
let globalAllowed = true;
const rateLimitCalls: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: signedIn ? { id: "user-1" } : null },
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (_fn: string, args: Record<string, unknown>) => {
      rateLimitCalls.push(args);
      const bucket = String(args.p_bucket);
      if (bucket === "suggest-global-min") {
        return Promise.resolve({ data: globalAllowed, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
  }),
}));

function suggestRequest(q: string) {
  return {
    nextUrl: { searchParams: new URL(`https://x/?q=${encodeURIComponent(q)}`).searchParams },
  } as unknown as NextRequest;
}

describe("address-suggest cannot be turned into a flood at Photon", () => {
  const route = src("../app/api/address-suggest/route.ts");

  beforeEach(() => {
    signedIn = true;
    globalAllowed = true;
    rateLimitCalls.length = 0;
    // The route keeps two pieces of module state: the suggestion cache and the
    // log-once window. A fresh module per test means neither leaks between
    // them (the mocks above are registered by path and survive this).
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares an owner-wide bucket on top of the per-user one", () => {
    // The per-user limit bounds one account. Photon's only defence against N
    // accounts is blocking the source, and the source is Hearth's shared
    // Vercel egress IPs - so the punishment lands on the whole deployment.
    expect(route).toContain('SUGGEST_GLOBAL_BUCKET = "suggest-global-min"');
    expect(route).toContain("p_window_seconds: 60");

    // The size of the ceiling is asserted as a RELATION to the per-user
    // budget, not as a literal. It used to be 600, which is exactly ten users'
    // worth of the 60/min per-user limit - so ten real people typing at the
    // same time could trip it on each other, and the only symptom is a
    // suggestion list that silently stops appearing. A ceiling a plausible
    // number of real users can reach is not protecting Photon from anything;
    // it has to sit above what the per-user budgets legitimately sum to.
    const perUser = Number(
      route.match(/addr-suggest:\$\{user\.id\}`,\s*p_limit: (\d+)/)?.[1]
    );
    const owner = Number(route.match(/SUGGEST_GLOBAL_PER_MINUTE = (\d+)/)?.[1]);
    expect(perUser).toBeGreaterThan(0);
    expect(owner).toBeGreaterThan(perUser * 10);
    // Still a hard stop, and still far below anything Komoot would read as
    // abuse - the 10-minute response cache means real typing never gets close.
    expect(owner).toBeLessThanOrEqual(2000);
  });

  it("returns an empty list and never calls Photon once the ceiling trips", async () => {
    globalAllowed = false;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../app/api/address-suggest/route");

    const res = await GET(suggestRequest("123 Main St"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs the trip with the greppable prefix, once per window and not per request", async () => {
    // A tripped ceiling means every keystroke from every signed-in account
    // arrives here, so a line per request turns one flood into two - the
    // second one being the log bill.
    globalAllowed = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../app/api/address-suggest/route");

    await GET(suggestRequest("456 Oak Ave"));
    await GET(suggestRequest("456 Oak Avenue"));
    await GET(suggestRequest("789 Elm Ct"));

    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain(
      "[ALERT] address-suggest global ceiling tripped"
    );
  });

  it("spends the per-user bucket first, so one account is refused before the ceiling", async () => {
    globalAllowed = true;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ features: [] }))
    );
    const { GET } = await import("../app/api/address-suggest/route");

    await GET(suggestRequest("789 Pine Rd"));

    const buckets = rateLimitCalls.map((c) => String(c.p_bucket));
    expect(buckets[0]).toBe("addr-suggest:user-1");
    expect(buckets[1]).toBe("suggest-global-min");
  });

  it("still fails open if the limiter itself is broken", () => {
    // A limiter outage must not cost a real homeowner their suggestions.
    expect(route).toContain("address-suggest rate_limit_hit failed - allowing:");
  });
});
