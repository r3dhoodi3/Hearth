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

  // Measured against the live API on 2026-08-28: RentCast answers an address
  // it holds no record for with HTTP 404 and
  // {"error":"resource/not-found","message":"No data found for address..."},
  // NOT with an empty 200 array. Four real Orange County addresses returned
  // 404 in every format tried (typed-out and USPS-abbreviated, with and
  // without city/state), while a known-good address returned 200 in ~1s - so
  // this is the shape of a MISS, and treating it as an outage told five of ten
  // testers "we couldn't reach the county records right now" about an address
  // the county records had answered plainly.
  it('a 404 is a true miss: "none", and cached as one', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(404, {
          status: 404,
          error: "resource/not-found",
          message: "No data found for address '1920 Main Street, 92614'",
        })
      )
    );
    const facts = await lookupParcel("1920 Main Street", "92614");
    expect(facts.source).toBe("none");
    // Cached, so a retype of the same unknown address does not re-bill a
    // lookup out of a 50-a-month quota. This is the whole practical
    // difference between a miss and an outage.
    expect(writes.map((w) => w.source)).toEqual(["none"]);
  });

  // The rule the two tests either side of this one enforce together: only a
  // 404 may be cached as a miss. Every other non-ok status is an outage.
  it("never caches a non-404 error status as a miss", async () => {
    for (const status of [401, 403, 429, 500, 502, 503]) {
      writes = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(status, { error: "nope" }))
      );
      const facts = await lookupParcel("17361 Ash St", "92708");
      expect(facts.source, `status ${status}`).toBe("unavailable");
      expect(writes, `status ${status}`).toEqual([]);
    }
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

  // The other half of the 2026-08-28 measurement: two of eight live calls
  // never opened a socket at all, rejecting in ~270ms with an ETIMEDOUT
  // AggregateError, and both succeeded immediately on a second attempt. No
  // timeout value helps a connection that is refused in a quarter second - a
  // retry does.
  it("retries once when the connection fails, and uses the second answer", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(200, [RECORD]);
      })
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(calls).toBe(2);
    expect(facts.source).toBe("rentcast");
    expect(facts.year_built).toBe(1968);
  });

  it("retries once on an abort, and uses the second answer", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          throw err;
        }
        return jsonResponse(200, [RECORD]);
      })
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(calls).toBe(2);
    expect(facts.source).toBe("rentcast");
  });

  // A status is an answer. Retrying one spends a second billed call to be told
  // the same thing - and on a 429 it pushes further into the ceiling that
  // caused it.
  it.each([
    ["404 (no such address)", 404],
    ["401 (bad or expired key)", 401],
    ["429 (quota exhausted)", 429],
    ["500 (provider outage)", 500],
  ])("never retries a %s", async (_label, status) => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return jsonResponse(status, { error: "nope" });
      })
    );
    await lookupParcel("17361 Ash St", "92708");
    expect(calls).toBe(1);
  });

  it("gives up after two failed attempts rather than looping", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw new TypeError("fetch failed");
      })
    );
    const facts = await lookupParcel("17361 Ash St", "92708");
    expect(calls).toBe(2);
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

  // fetch() resolves as soon as the HEADERS arrive - the body is streamed
  // after that, and res.json() waits for all of it. The abort timer used to
  // be cleared the instant those headers landed, so a body that stalled
  // mid-stream was bounded by nothing at all: the await never returned, and
  // the whole request behind it (a claim, or a job post's lazy ownership
  // re-check) hung with it. Fake timers here so the 15s budget can be walked
  // past without the test actually waiting for it.
  it('a body that never arrives is "unavailable" and is not cached', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          // Never settles, and never rejects either.
          json: () => new Promise(() => {}),
        }))
      );
      const pending = lookupParcel("17361 Ash St", "92708");
      await vi.advanceTimersByTimeAsync(20_000);
      const facts = await pending;
      expect(facts.source).toBe("unavailable");
      expect(writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an AVM body that never arrives is "unavailable" and is not cached', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        }))
      );
      const pending = lookupMarketValue("17361 Ash St", "92708");
      await vi.advanceTimersByTimeAsync(20_000);
      const facts = await pending;
      expect(facts.source).toBe("unavailable");
      expect(writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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

  // Same rule as the property record: a 404 is RentCast saying it has no
  // estimate for this address, which is an answer worth remembering for a day
  // rather than an outage worth re-billing on every visit to /value.
  it('a 404 is a real miss: "none", and is cached', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: "resource/not-found" }))
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
// SHAPE is the fix: rewriting an explicit `=== "no_match"` as `!== "match"`
// (or as a truthy check on blank facts) compiles, passes every other test,
// works perfectly while the sources are up, and re-creates the outage the
// moment one of them goes down.
// ---------------------------------------------------------------------------
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("the onboarding refusal gates", () => {
  const onboarding = src("../app/onboarding/actions.ts");

  // 2026-08-28: the Continue step used to refuse on `publicFacts.source ===
  // "none"`, i.e. on RentCast having no record. Measuring RentCast against
  // four plausible Orange County addresses (all four a hard 404) showed its
  // silence is not evidence about whether a home exists, so the refusal moved
  // to the geocoder. This shape must not come back.
  it("never refuses on a records miss", () => {
    expect(onboarding).not.toContain('publicFacts.source === "none"');
    expect(onboarding).not.toContain('facts.source === "none"');
  });

  it("refuses only on an explicit geocoder no_match", () => {
    // `=== "no_match"` and nothing looser. `!== "match"` would swallow
    // "unavailable" - a Photon timeout, a 500, an empty answer - back into a
    // refusal, which is the 2026-08-24 outage with a different vendor's name
    // on it.
    expect(onboarding).toContain('verdict === "no_match"');
    expect(onboarding).not.toContain('verdict !== "match"');
    expect(onboarding).not.toContain("!verdict");
  });

  it("spends a geocoder call only when there is no county record", () => {
    // A found record IS confirmation the address is real; asking Photon to
    // agree would be a second lookup to learn nothing.
    expect(onboarding).toContain('publicFacts.source !== "rentcast"');
    expect(onboarding).toContain('claimFacts?.source === "rentcast"');
  });

  it("routes the claim-time decision through the tested gate", () => {
    // The claim gate's behaviour lives in parcelGate.test.ts; this just holds
    // the action to calling it rather than re-deriving the rule inline.
    expect(onboarding).toContain("claimAddressGate({");
    expect(onboarding).toContain('gate.reason === "lookup_blocked"');
  });

  it("attaches parcel facts only when a record was actually found", () => {
    // Now that a miss walks on to the claim, every parcel-derived value on an
    // unedited claim still comes out of a hidden form field - so a hand-made
    // POST for an address nothing has a record for could otherwise arrive
    // carrying a parcel number, a sale price and an assessed value.
    expect(onboarding).toContain('claimFacts.source === "rentcast"');
  });

  it("gates the ownership write on the shared recording rule", () => {
    // Not just "unverified vs verified": recording ANYTHING stamps
    // ownership_checked_at and burns the lazy re-check. See
    // shouldRecordOwnershipCheck in ownershipMatch.ts.
    expect(onboarding).toContain("shouldRecordOwnershipCheck(facts)");
    // And the third lookupParcel call is gone: the ownership check reuses the
    // facts the gate already fetched - and drops them when the record turns
    // out to describe a different street than the one being claimed (see
    // parcelFactsMatchClaim / src/lib/addressMatch.ts).
    expect(onboarding).toContain(
      "const facts = parcelFactsMatchClaim ? claimFacts : null;"
    );
    // Three lookupParcel calls in the whole file, and no more: one in
    // lookupParcelAction (the Continue step), and two in claimPropertyAction
    // (the corrected-address lookup and the unedited re-check, only one of
    // which ever runs). A fourth would be the ownership check re-asking a
    // question the gate already answered.
    expect(onboarding.match(/await lookupParcel\(/g)?.length ?? 0).toBeLessThanOrEqual(3);
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

  // Order is the fix. `if (!res.ok)` matches a 404 too, so the 404 branch only
  // means anything while it comes first - move it after and every unknown
  // address is an "outage" again, with the tests above the only thing to say
  // so. Checked on both call sites (property record and AVM).
  it("classifies a 404 before falling into the not-ok branch", () => {
    const miss1 = parcel.indexOf("res.status === 404");
    const notOk1 = parcel.indexOf("if (!res.ok)");
    const miss2 = parcel.indexOf("res.status === 404", miss1 + 1);
    const notOk2 = parcel.indexOf("if (!res.ok)", notOk1 + 1);
    expect(miss1).toBeGreaterThan(-1);
    expect(miss2).toBeGreaterThan(miss1);
    expect(notOk2).toBeGreaterThan(notOk1);
    expect(miss1).toBeLessThan(notOk1);
    expect(miss2).toBeLessThan(notOk2);
  });

  it("bounds the retry so two attempts cannot stack two full timeouts", () => {
    const attempt = Number(
      parcel.match(/RENTCAST_ATTEMPT_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, "")
    );
    const total = Number(
      parcel.match(/RENTCAST_TOTAL_BUDGET_MS = ([\d_]+)/)?.[1].replace(/_/g, "")
    );
    expect(attempt).toBeGreaterThan(0);
    // A real answer measured at 0.5-2.3s, so the per-attempt budget is
    // generous without being a page-long wait.
    expect(attempt).toBeLessThanOrEqual(12_000);
    // The whole point of a shared deadline: the ceiling is well under two
    // attempts' worth, and claimPropertyAction can make two of these calls.
    expect(total).toBeGreaterThan(attempt);
    expect(total).toBeLessThan(attempt * 2);
  });
});
