import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// parcel.ts imports the service-role Supabase client, which pulls in
// "server-only" and throws the moment it is imported outside a server
// component. Mocking that module out means the real lookup logic below can be
// exercised for real against a fake table, the same trick aiUsage.test.ts uses.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

// Every row the code under test tried to write, in order.
let writes: { cache_key: string; source: string }[] = [];
// What the cache read should hand back (null = a miss, which is every test
// here: these are about what happens on the way OUT).
let cachedRow: { facts: unknown; source: string; fetched_at: string } | null =
  null;
let currentAdmin: unknown = null;

function fakeAdmin() {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: cachedRow, error: null }),
              };
            },
          };
        },
        async upsert(row: { cache_key: string; source: string }) {
          writes.push({ cache_key: row.cache_key, source: row.source });
          return { error: null };
        },
      };
    },
  };
}

// A minimal RentCast property record: enough of an address echo that the
// parser accepts it as a real hit.
const RECORD = {
  id: "abc",
  addressLine1: "17361 Ash St",
  city: "Fountain Valley",
  state: "CA",
  zipCode: "92708",
  yearBuilt: 1968,
  owner: { names: ["JANE DOE"], type: "Individual" },
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let lookupParcel: typeof import("./parcel").lookupParcel;
let lookupMarketValue: typeof import("./parcel").lookupMarketValue;

beforeEach(async () => {
  writes = [];
  cachedRow = null;
  currentAdmin = fakeAdmin();
  process.env.RENTCAST_API_KEY = "test-key";
  ({ lookupParcel, lookupMarketValue } = await import("./parcel"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RENTCAST_API_KEY;
});

describe("lookupParcel source semantics", () => {
  it('a found record is "rentcast" and gets cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, [RECORD]))
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(facts.source).toBe("rentcast");
    expect(facts.year_built).toBe(1968);
    expect(writes.some((w) => w.source === "rentcast")).toBe(true);
  });

  it('an empty array is a true miss: "none", and cached as one', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, []))
    );
    const facts = await lookupParcel("123 Fake St", "92648");
    expect(facts.source).toBe("none");
    // A miss IS an answer, so remembering it for a day is right: it keeps a
    // retype of the same unknown address from re-billing RentCast.
    expect(writes.map((w) => w.source)).toEqual(["none"]);
  });

  it('a record with no address echo is also a miss, not "unavailable"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, [{ id: "x" }]))
    );
    const facts = await lookupParcel("123 Fake St", "92648");
    expect(facts.source).toBe("none");
  });

  // The 2026-08-24 outage: a bad key on the host answered 401 for every real
  // address, every one of them collapsed into "none", and onboarding refused
  // them all for a day. Each of these must be "unavailable" instead.
  it.each([
    ["401 (bad or expired key)", 401],
    ["429 (quota exhausted)", 429],
    ["500 (provider outage)", 500],
  ])('%s is "unavailable" and is NEVER cached', async (_label, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(status, { error: "nope" }))
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    // Blank facts, so the confirm step is a manual-entry form.
    expect(facts.year_built).toBeNull();
    expect(facts.address_line1).toBe("17361 Ash St");
    // Nothing written, under either the typed key or the canonical one: a
    // cached non-answer would outlive the fix to the key.
    expect(writes).toEqual([]);
  });

  it('an aborted (timed out) request is "unavailable" and is not cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      })
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    expect(writes).toEqual([]);
  });

  it('a network failure is "unavailable" and is not cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    expect(writes).toEqual([]);
  });

  it('an unparseable body is "unavailable" and is not cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }))
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    expect(writes).toEqual([]);
  });

  it('with no key configured nothing is looked up and the source is "none"', async () => {
    delete process.env.RENTCAST_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(facts.source).toBe("none");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("lookupMarketValue source semantics", () => {
  it("caches a real estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          price: 890_000,
          priceRangeLow: 840_000,
          priceRangeHigh: 950_000,
        })
      )
    );
    const facts = await lookupMarketValue("17361 Ash St", "92708");
    expect(facts.market_value).toBe(890_000);
    expect(facts.source).toBe("rentcast");
    expect(writes.map((w) => w.source)).toEqual(["rentcast"]);
    // The AVM key is separate from the property-record key, so the two can
    // never overwrite each other for the same address.
    expect(writes[0].cache_key.endsWith("|avm")).toBe(true);
  });

  it("keys the cache per unit, so two condos never share one estimate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { price: 500_000 }))
    );
    await lookupMarketValue("17361 Ash St", "92708", "4B");
    expect(writes[0].cache_key).toContain("/4b");
  });

  it('a valid object with no price is a real miss: "none", and is cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { message: "no estimate available" }))
    );
    const facts = await lookupMarketValue("17361 Ash St", "92708");
    expect(facts.source).toBe("none");
    expect(facts.market_value).toBeNull();
    expect(writes.map((w) => w.source)).toEqual(["none"]);
  });

  it.each([
    ["401 (bad or expired key)", 401],
    ["429 (quota exhausted)", 429],
    ["500 (provider outage)", 500],
  ])('%s is "unavailable" and is NEVER cached', async (_label, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(status, { error: "nope" }))
    );
    const facts = await lookupMarketValue("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    expect(writes).toEqual([]);
  });

  it('a 200 body that is not even an object is "unavailable", not a miss', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, "service temporarily down"))
    );
    const facts = await lookupMarketValue("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    expect(writes).toEqual([]);
  });

  it('a timeout is "unavailable" and is not cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      })
    );
    const facts = await lookupMarketValue("17361 Ash St", "92708");
    expect(facts.source).toBe("unavailable");
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Source-text checks. The refusal gates are one-line conditions whose exact
// SHAPE is the fix: rewriting `=== "none"` as `!== "rentcast"` (or as a truthy
// check on blank facts) compiles, passes every other test, works perfectly
// while RentCast is up, and re-creates the outage the moment a key goes bad.
// ---------------------------------------------------------------------------
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("the onboarding refusal gates", () => {
  const onboarding = src("../app/onboarding/actions.ts");

  it("refuses the Continue step only on an explicit source === \"none\"", () => {
    expect(onboarding).toContain('publicFacts.source === "none"');
  });

  it("routes the claim-time decision through the tested gate", () => {
    // The claim gate's behaviour lives in parcelGate.test.ts; this just holds
    // the action to calling it rather than re-deriving the rule inline.
    expect(onboarding).toContain("claimAddressGate({");
    expect(onboarding).toContain('gate.reason === "lookup_blocked"');
  });

  it("never refuses on a negated or falsy source check", () => {
    // Any of these would swallow "unavailable" back into a refusal.
    expect(onboarding).not.toContain('source !== "rentcast"');
    expect(onboarding).not.toContain("!facts.source");
    expect(onboarding).not.toContain("!publicFacts.source");
  });

  it("gates the ownership write on the shared recording rule", () => {
    // Not just "unverified vs verified": recording ANYTHING stamps
    // ownership_checked_at and burns the lazy re-check. See
    // shouldRecordOwnershipCheck in ownershipMatch.ts.
    expect(onboarding).toContain("shouldRecordOwnershipCheck(facts)");
    // And the third lookupParcel call is gone: the ownership check reuses the
    // facts the gate already fetched.
    expect(onboarding).toContain("const facts = claimFacts;");
  });
});

describe("the lazy ownership re-check on first job post", () => {
  const contractors = src("../app/(app)/contractors/actions.ts");

  it("uses the same recording rule, so an outage keeps its retry", () => {
    expect(contractors).toContain("shouldRecordOwnershipCheck(facts)");
  });
});

describe("the AVM refresh action", () => {
  const valueActions = src("../app/(app)/value/actions.ts");

  it("is metered, since an uncached outage would reach RentCast every call", () => {
    expect(valueActions).toContain("rate_limit_hit");
    expect(valueActions).toContain("avm:${userId}");
    expect(valueActions).toContain("avm-day:${userId}");
  });

  it("spends its own buckets, never the onboarding lookup budget", () => {
    expect(valueActions).not.toContain("parcel:${userId}");
    expect(valueActions).not.toContain("parcel-day:${userId}");
  });

  it("meters BOTH paths that can reach RentCast, on the one budget", () => {
    // There are two: the free first-estimate fetch, and the Plus-only manual
    // refresh. They cost the same money, so they share one per-user budget -
    // a second entry point with its own (or no) limit would be a way around
    // the first one's.
    const calls = valueActions.match(/avmBudgetAllows\(/g) ?? [];
    // One declaration plus one call from each action.
    expect(calls.length).toBe(3);
  });

  it("refuses a refresh from a free account server-side", () => {
    // The button a free account sees is a link to /plus, not a submit, but
    // the action is callable directly by anything holding a session: the only
    // path that can bill RentCast a SECOND time for one home checks
    // membership on the server before it spends anything.
    const refresh = valueActions.indexOf(
      "export async function refreshMarketValueAction"
    );
    expect(refresh).toBeGreaterThan(-1);
    const gate = valueActions.indexOf("await hasPlus()", refresh);
    const lookup = valueActions.indexOf("lookupMarketValue(", refresh);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(lookup);
  });
});

describe("parcel.ts caching", () => {
  const parcel = src("./parcel.ts");

  it("guards both cache writers against an unavailable result", () => {
    // Two writers (the property record and the AVM), each gated.
    const guards = parcel.match(/facts\.source !== "unavailable"/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it("logs the HTTP status on the unavailable path", () => {
    expect(parcel).toContain(
      "RentCast returned HTTP ${res.status} for address lookup"
    );
  });
});
