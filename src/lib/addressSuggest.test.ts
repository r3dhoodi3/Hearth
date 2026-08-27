import { describe, expect, it } from "vitest";
import {
  mapPhotonResults,
  normalizeSuggestQuery,
  photonSuggestUrl,
  MIN_SUGGEST_QUERY,
  OC_BBOX,
  PHOTON_RAW_LIMIT,
  SUGGEST_LIMIT,
} from "./addressSuggest";

// Builds one Photon GeoJSON feature. Every field optional, exactly as the
// real API returns them.
function feature(props: Record<string, unknown>) {
  return { type: "Feature", properties: props, geometry: null };
}
function body(...features: unknown[]) {
  return { type: "FeatureCollection", features };
}

// Shapes copied from real photon.komoot.io responses for the launch area, so
// the mapper is tested against what the service actually sends rather than an
// idealized version of it.
const BOLSA = feature({
  osm_type: "N",
  housenumber: "9842",
  street: "Bolsa Avenue",
  city: "Westminster",
  state: "California",
  postcode: "92844",
  countrycode: "US",
});
const KINGS_CANYON = feature({
  housenumber: "9871",
  street: "Kings Canyon Drive",
  city: "Huntington Beach",
  postcode: "92646",
});

describe("normalizeSuggestQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSuggestQuery("  9832   Bolsa   Ave ")).toBe(
      "9832 Bolsa Ave"
    );
  });

  it("returns empty for anything shorter than the floor, so no request is made", () => {
    expect(normalizeSuggestQuery("98")).toBe("");
    expect(normalizeSuggestQuery("   ")).toBe("");
    expect(normalizeSuggestQuery(null)).toBe("");
    expect(normalizeSuggestQuery(undefined)).toBe("");
    expect(normalizeSuggestQuery("9".repeat(MIN_SUGGEST_QUERY))).toHaveLength(
      MIN_SUGGEST_QUERY
    );
  });

  it("caps a long query before it reaches an outbound URL", () => {
    expect(normalizeSuggestQuery("a".repeat(500))).toHaveLength(200);
  });
});

describe("photonSuggestUrl", () => {
  it("carries the Orange County bbox in Photon's minLon,minLat,maxLon,maxLat order", () => {
    const url = new URL(photonSuggestUrl("9832 Bol"));
    expect(url.searchParams.get("bbox")).toBe(
      `${OC_BBOX.minLon},${OC_BBOX.minLat},${OC_BBOX.maxLon},${OC_BBOX.maxLat}`
    );
    expect(url.searchParams.get("limit")).toBe(String(PHOTON_RAW_LIMIT));
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.origin + url.pathname).toBe("https://photon.komoot.io/api/");
  });

  it("appends California so a bare house number and street prefix reads as an address", () => {
    const url = new URL(photonSuggestUrl("9832 Bol"));
    expect(url.searchParams.get("q")).toBe("9832 Bol, California");
  });

  it("names the launch city when the ZIP box already identifies one", () => {
    const url = new URL(photonSuggestUrl("9832 Bol", "92683"));
    expect(url.searchParams.get("q")).toBe("9832 Bol, Westminster, California");
  });

  it("ignores a ZIP outside the launch area rather than sending a wrong city", () => {
    // 90210 is a real ZIP, just not one of ours.
    const url = new URL(photonSuggestUrl("9832 Bol", "90210"));
    expect(url.searchParams.get("q")).toBe("9832 Bol, California");
  });
});

describe("mapPhotonResults", () => {
  it("maps a launch-area house to line1 / city / state / zip", () => {
    expect(mapPhotonResults(body(KINGS_CANYON))).toEqual([
      {
        line1: "9871 Kings Canyon Drive",
        city: "Huntington Beach",
        state: "CA",
        zip: "92646",
      },
    ]);
  });

  it("drops results with no house number", () => {
    // A street centerline and a bus stop: both come back typed as "house" by
    // Photon, and neither is an address anyone lives at.
    const centerline = feature({
      street: "Bolsa Avenue",
      city: "Westminster",
      postcode: "92683",
    });
    const busStop = feature({
      name: "Bolsa-Brookhurst",
      street: "Bolsa Avenue",
      city: "Westminster",
      postcode: "92683",
    });
    expect(mapPhotonResults(body(centerline, busStop))).toEqual([]);
  });

  it("drops a house number with no street name", () => {
    const orphan = feature({
      housenumber: "9401",
      name: "Bolsa Grande High School",
      city: "Garden Grove",
      postcode: "92844",
    });
    expect(mapPhotonResults(body(orphan))).toEqual([]);
  });

  it("keeps addresses anywhere in Orange County since the launch area is the county", () => {
    const irvine = feature({
      housenumber: "100",
      street: "Technology Drive",
      city: "Irvine",
      postcode: "92618",
    });
    const anaheim = feature({
      housenumber: "1313",
      street: "Disneyland Drive",
      city: "Anaheim",
      postcode: "92802",
    });
    expect(mapPhotonResults(body(irvine, anaheim))).toEqual([
      { line1: "100 Technology Drive", city: "Irvine", state: "CA", zip: "92618" },
      { line1: "1313 Disneyland Drive", city: "Anaheim", state: "CA", zip: "92802" },
    ]);
  });

  it("drops addresses outside the county", () => {
    // Long Beach sits inside the bbox's northwest corner, but the ZIP gate on
    // the very next screen would reject it. Offering it would be a trap.
    const longBeach = feature({
      housenumber: "1",
      street: "Ocean Boulevard",
      city: "Long Beach",
      postcode: "90802",
    });
    expect(mapPhotonResults(body(longBeach))).toEqual([]);
  });

  it("drops a result with no ZIP at all", () => {
    const noZip = feature({
      housenumber: "9871",
      street: "Kings Canyon Drive",
      city: "Huntington Beach",
    });
    expect(mapPhotonResults(body(noZip))).toEqual([]);
  });

  it("normalizes a ZIP+4 to five digits", () => {
    const plusFour = feature({
      housenumber: "9871",
      street: "Kings Canyon Drive",
      city: "Huntington Beach",
      postcode: "92646-1234",
    });
    expect(mapPhotonResults(body(plusFour))[0]).toMatchObject({
      zip: "92646",
    });
  });

  it("shows OSM's city when it is itself a launch city, even if the ZIP maps elsewhere", () => {
    // 92844 is a Garden Grove ZIP, but this address sits on the Westminster
    // side of the line and OSM says so. The ZIP still gates (it is a launch
    // ZIP either way); the name shown is the one the resident recognizes.
    expect(mapPhotonResults(body(BOLSA))[0]).toEqual({
      line1: "9842 Bolsa Avenue",
      city: "Westminster",
      state: "CA",
      zip: "92844",
    });
  });

  it("resolves the community names OSM uses through the ZIP map", () => {
    // Photon returns the neighborhood or annexed community for a lot of
    // Orange County: none of these is a checkbox or DB name, and the ZIP map
    // is what turns each into the city that serves it.
    const cases: [string, string, string][] = [
      ["Sunset Beach", "90742", "Huntington Beach"],
      ["Corona del Mar", "92625", "Newport Beach"],
      ["Capistrano Beach", "92624", "Dana Point"],
      ["Trabuco Canyon", "92679", "Rancho Santa Margarita"],
      ["Coto de Caza", "92679", "Rancho Santa Margarita"],
      ["Silverado", "92676", "Orange"],
      ["Ladera Ranch", "92694", "Ladera Ranch"],
      ["Rossmoor", "90720", "Los Alamitos"],
      ["North Tustin", "92705", "Santa Ana"],
      ["Foothill Ranch", "92610", "Lake Forest"],
    ];
    for (const [osmCity, zip, expected] of cases) {
      const f = feature({
        housenumber: "1",
        street: "Main Street",
        city: osmCity,
        postcode: zip,
      });
      expect(mapPhotonResults(body(f))[0], osmCity).toMatchObject({
        city: expected,
        zip,
      });
    }
  });

  it("drops a ZIP outside the map even when OSM names a launch city", () => {
    // 92899 is a unique (non-residential) Anaheim ZIP the map does not know.
    // OSM calling the address Fullerton does not help: the ZIP is what the
    // onboarding gate checks next, and it would bounce this straight to the
    // waitlist panel. A suggestion that cannot be accepted is a trap.
    const unknownZip = feature({
      housenumber: "200",
      street: "Harbor Boulevard",
      city: "Fullerton",
      postcode: "92899",
    });
    expect(mapPhotonResults(body(unknownZip))).toEqual([]);
  });

  it("drops a result when neither the ZIP nor OSM's city resolves", () => {
    const nowhere = feature({
      housenumber: "200",
      street: "Harbor Boulevard",
      city: "Capistrano Beach",
      postcode: "92899",
    });
    expect(mapPhotonResults(body(nowhere))).toEqual([]);
  });

  it("de-duplicates the several OSM nodes one address usually has", () => {
    expect(mapPhotonResults(body(KINGS_CANYON, KINGS_CANYON))).toHaveLength(1);
  });

  it("caps the list at the number the form shows", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      feature({
        housenumber: String(9800 + i),
        street: "Bolsa Avenue",
        city: "Westminster",
        postcode: "92683",
      })
    );
    expect(mapPhotonResults(body(...many))).toHaveLength(SUGGEST_LIMIT);
  });

  it("returns an empty list for anything that is not a FeatureCollection", () => {
    // Photon is a free service with no uptime promise: an HTML error page, a
    // truncated body, or null must all read as "no suggestions", never throw.
    expect(mapPhotonResults(null)).toEqual([]);
    expect(mapPhotonResults(undefined)).toEqual([]);
    expect(mapPhotonResults("<html>502</html>")).toEqual([]);
    expect(mapPhotonResults({ features: "nope" })).toEqual([]);
    expect(mapPhotonResults(body(null, 42, { properties: null }))).toEqual([]);
  });

  it("ignores non-string field values rather than stringifying them", () => {
    const junk = feature({
      housenumber: 9871,
      street: ["Kings Canyon Drive"],
      postcode: 92646,
    });
    expect(mapPhotonResults(body(junk))).toEqual([]);
  });
});
