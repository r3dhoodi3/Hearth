import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAddressVerifyCache, verifyAddressExists } from "./addressVerify";

// The geocoder existence check: the thing that now stands between a made-up
// address and a claimed home, after a RentCast miss stopped being grounds to
// refuse one (see src/lib/parcelGate.ts).
//
// Every body below is shaped like a real photon.komoot.io response for the
// launch area, and the two decisive ones are transcripts: what Photon actually
// returned on 2026-08-28 for a real address RentCast had no record of, and for
// an invented one.

function feature(props: Record<string, unknown>) {
  return { type: "Feature", properties: props, geometry: null };
}
function body(...features: unknown[]) {
  return { type: "FeatureCollection", features };
}
function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

// 1920 Main Street, Irvine 92614. A real address, a hard 404 at RentCast, and
// known to Photon - the exact case that made the records source unusable as a
// fake-address gate.
const MAIN_STREET = body(
  feature({
    housenumber: "1920",
    street: "Main Street",
    city: "Irvine",
    postcode: "92614",
  })
);

// 16781 Bolsa Chica St, Huntington Beach. A real address whose house number
// OSM has never mapped: Photon answers with the ROAD, a channel and a state
// beach. An exact-address check refused this one, which is why the bar is the
// street.
const BOLSA_CHICA = body(
  feature({ name: "Bolsa Chica State Beach", city: "Huntington Beach" }),
  feature({ street: "Bolsa Chica Road", name: "Bolsa Chica-St James" }),
  feature({ name: "Bolsa Chica Channel" })
);

// "123 Fake Street, California" - fifteen genuine addresses, none of them on
// any street by that name.
const FAKE_STREET = body(
  feature({ housenumber: "123", street: "North Sunkist Street", city: "Anaheim" }),
  feature({ housenumber: "123", street: "South Kingsley Street", city: "Anaheim" }),
  feature({ housenumber: "123", street: "South Kroeger Street", city: "Anaheim" })
);

beforeEach(() => {
  resetAddressVerifyCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyAddressExists", () => {
  it("matches a real address the records source had never heard of", () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, MAIN_STREET)));
    return expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "match"
    );
  });

  it("refuses an invented street, despite a page of near misses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, FAKE_STREET)));
    await expect(verifyAddressExists("123 Fake Street", "92648")).resolves.toBe(
      "no_match"
    );
  });

  it("matches a real address whose house number OSM never mapped", async () => {
    // 0 of 20 real Orange County addresses were refused once the bar became
    // the street; the exact-address version refused 4 of 10.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, BOLSA_CHICA)));
    await expect(
      verifyAddressExists("16781 Bolsa Chica St", "92649")
    ).resolves.toBe("match");
  });

  it("matches through USPS abbreviation differences", async () => {
    // The homeowner types the short form, OSM holds the long one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          200,
          body(
            feature({
              housenumber: "1770",
              street: "South Harbor Boulevard",
              city: "Anaheim",
              postcode: "92802",
            })
          )
        )
      )
    );
    await expect(
      verifyAddressExists("1770 S Harbor Blvd", "92802")
    ).resolves.toBe("match");
  });

  // ---------------------------------------------------------------------
  // FAIL OPEN. Photon is a free community service with no uptime promise, and
  // "we couldn't check" must never become "this address does not exist" - the
  // mistake this codebase already made with RentCast on 2026-08-24, which
  // refused every real signup for a day.
  // ---------------------------------------------------------------------
  it.each([
    ["500 (outage)", 500],
    ["429 (rate limited at the source)", 429],
    ["404", 404],
  ])("is unavailable, not a refusal, on HTTP %s", async (_label, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(status, {})));
    await expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "unavailable"
    );
  });

  it("is unavailable on a timeout or network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      })
    );
    await expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "unavailable"
    );
  });

  it("is unavailable on a body that is not JSON", async () => {
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
    await expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "unavailable"
    );
  });

  // NO RESULTS IS NOT A "NO". An empty answer is as consistent with a service
  // degradation or an indexing gap as with a fabricated address, and a
  // refusal has to rest on Photon having offered addresses that are not this
  // one. A real fake looks like FAKE_STREET above, not like silence.
  it("is unavailable, not a refusal, when nothing came back at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, body())));
    await expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "unavailable"
    );
  });

  it("refuses a street name typed with no house number at all", async () => {
    // "Brookhurst" alone, the 2026-08-27 persona case. Photon names South
    // Brookhurst STREET and a park; neither core is the bare "brookhurst"
    // typed, so this is a refusal - correctly, since a street name without a
    // number is not an address and the message points at the suggestion list.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          200,
          body(
            feature({ street: "South Brookhurst Street", city: "Anaheim" }),
            feature({ name: "Brookhurst Park", city: "Anaheim" })
          )
        )
      )
    );
    await expect(verifyAddressExists("Brookhurst", "92804")).resolves.toBe(
      "no_match"
    );
  });

  it("does not call the geocoder for a query too short to search", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(verifyAddressExists("12", "92614")).resolves.toBe(
      "unavailable"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the verdict cache", () => {
  it("asks the geocoder once for a signup that checks the same address twice", async () => {
    // The Continue step and the Claim step both verify, and a household
    // retyping after a correction makes it more. One outbound request.
    const fetchSpy = vi.fn(async () => jsonResponse(200, MAIN_STREET));
    vi.stubGlobal("fetch", fetchSpy);
    await verifyAddressExists("1920 Main Street", "92614");
    await verifyAddressExists("1920  main street ", "92614");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never caches an outage, so a retry can get a real answer", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) return jsonResponse(500, {});
        return jsonResponse(200, MAIN_STREET);
      })
    );
    await expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "unavailable"
    );
    await expect(verifyAddressExists("1920 Main Street", "92614")).resolves.toBe(
      "match"
    );
  });

  it("keys on the ZIP as well as the street", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, MAIN_STREET));
    vi.stubGlobal("fetch", fetchSpy);
    await verifyAddressExists("1920 Main Street", "92614");
    await verifyAddressExists("1920 Main Street", "92708");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
