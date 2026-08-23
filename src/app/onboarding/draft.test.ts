import { describe, expect, it } from "vitest";
import {
  HOME_ONBOARDING_DRAFT_MAX_AGE_MS,
  parseHomeOnboardingDraft,
} from "./draft";

const NOW = 1_800_000_000_000;

const facts = {
  parcel_id: "APN-123",
  address_line1: "742 Evergreen Terrace",
  city: "Huntington Beach",
  state: "CA",
  zip: "92646",
  year_built: 1974,
  sqft: 1800,
  beds: 3,
  baths: 2,
  lot_size_sqft: 6000,
  property_type: "single_family",
  purchase_date: "2015-06-01",
  purchase_price: 700000,
  assessed_value: 810000,
  assessed_year: 2024,
  property_tax_history: [{ year: 2024, amount: 9100 }],
  latitude: 33.66,
  longitude: -117.99,
  hoa_fee: null,
  county: "Orange",
  market_value: 1100000,
  market_value_low: 1000000,
  market_value_high: 1200000,
  system_facts: { roof: "Asphalt shingle" },
  source: "rentcast",
};

function stored(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step: "ready",
    street: "742 Evergreen Terrace",
    unit: "",
    zip: "92646",
    fullName: "Alex Rivera",
    addressLine1: "742 Evergreen Terrace",
    facts,
    savedAt: NOW - 60_000,
    ...overrides,
  });
}

// Anything in localStorage is a previous version of our own write, a
// hand-edited value, or junk, so this is the whole trust boundary for the
// restored draft.
describe("parseHomeOnboardingDraft", () => {
  it("restores a fresh ready-phase draft with its facts", () => {
    const draft = parseHomeOnboardingDraft(stored(), NOW);
    expect(draft?.step).toBe("ready");
    expect(draft?.street).toBe("742 Evergreen Terrace");
    expect(draft?.zip).toBe("92646");
    expect(draft?.fullName).toBe("Alex Rivera");
    expect(draft?.facts?.address_line1).toBe("742 Evergreen Terrace");
    expect(draft?.facts?.year_built).toBe(1974);
    expect(draft?.facts?.source).toBe("rentcast");
    expect(draft?.facts?.system_facts).toEqual({ roof: "Asphalt shingle" });
    expect(draft?.facts?.property_tax_history).toEqual([
      { year: 2024, amount: 9100 },
    ]);
  });

  it("returns null for nothing, junk, and non-objects", () => {
    expect(parseHomeOnboardingDraft(null, NOW)).toBeNull();
    expect(parseHomeOnboardingDraft("", NOW)).toBeNull();
    expect(parseHomeOnboardingDraft("{not json", NOW)).toBeNull();
    expect(parseHomeOnboardingDraft('"a string"', NOW)).toBeNull();
    expect(parseHomeOnboardingDraft("[1,2,3]", NOW)).toBeNull();
  });

  it("drops a draft with no usable savedAt", () => {
    expect(parseHomeOnboardingDraft(stored({ savedAt: undefined }), NOW)).toBeNull();
    expect(parseHomeOnboardingDraft(stored({ savedAt: "yesterday" }), NOW)).toBeNull();
  });

  it("ignores drafts older than a week, and keeps one just inside it", () => {
    const old = stored({ savedAt: NOW - HOME_ONBOARDING_DRAFT_MAX_AGE_MS - 1 });
    expect(parseHomeOnboardingDraft(old, NOW)).toBeNull();

    const justInside = stored({
      savedAt: NOW - HOME_ONBOARDING_DRAFT_MAX_AGE_MS + 1000,
    });
    expect(parseHomeOnboardingDraft(justInside, NOW)?.step).toBe("ready");
  });

  it("ignores a draft stamped far in the future by a clock change", () => {
    const future = stored({
      savedAt: NOW + HOME_ONBOARDING_DRAFT_MAX_AGE_MS + 1000,
    });
    expect(parseHomeOnboardingDraft(future, NOW)).toBeNull();
  });

  it("falls back to the address step when the facts are missing or unusable", () => {
    expect(parseHomeOnboardingDraft(stored({ facts: null }), NOW)?.step).toBe(
      "address"
    );
    expect(
      parseHomeOnboardingDraft(stored({ facts: { city: "Irvine" } }), NOW)?.step
    ).toBe("address");
    // Fields typed on step 1 still come back, which is the point.
    expect(parseHomeOnboardingDraft(stored({ facts: null }), NOW)?.zip).toBe(
      "92646"
    );
  });

  it("never restores into an unknown step", () => {
    expect(parseHomeOnboardingDraft(stored({ step: "out_of_area" }), NOW)?.step).toBe(
      "address"
    );
    expect(parseHomeOnboardingDraft(stored({ step: 7 }), NOW)?.step).toBe("address");
  });

  it("treats an empty draft as no draft", () => {
    const empty = stored({
      step: "address",
      street: "",
      unit: "",
      zip: "",
      fullName: "",
      addressLine1: "",
      facts: null,
    });
    expect(parseHomeOnboardingDraft(empty, NOW)).toBeNull();
  });

  it("re-derives junk fields instead of handing them to the form", () => {
    const messy = parseHomeOnboardingDraft(
      stored({
        street: 42,
        fullName: { first: "Alex" },
        facts: {
          ...facts,
          year_built: "1974",
          beds: Number.NaN,
          source: "wikipedia",
          system_facts: { roof: 5 },
          property_tax_history: [{ year: "2024", amount: 9100 }],
        },
      }),
      NOW
    );
    expect(messy?.street).toBe("");
    expect(messy?.fullName).toBe("");
    expect(messy?.facts?.year_built).toBeNull();
    expect(messy?.facts?.beds).toBeNull();
    expect(messy?.facts?.source).toBe("none");
    expect(messy?.facts?.system_facts).toBeNull();
    expect(messy?.facts?.property_tax_history).toBeNull();
  });

  // The condo/townhome unit (migration 0127). It is the one detail that tells
  // unit 4B apart from the building, so losing it across a reload is not a
  // cosmetic loss.
  it("restores the unit typed on step 1", () => {
    expect(parseHomeOnboardingDraft(stored({ unit: "4B" }), NOW)?.unit).toBe("4B");
  });

  it("caps a hand-edited unit at the length the claim would keep anyway", () => {
    const long = parseHomeOnboardingDraft(stored({ unit: "A".repeat(200) }), NOW);
    expect(long?.unit).toHaveLength(20);
  });

  it("re-derives a non-string unit to empty", () => {
    expect(parseHomeOnboardingDraft(stored({ unit: 4 }), NOW)?.unit).toBe("");
    expect(parseHomeOnboardingDraft(stored({ unit: null }), NOW)?.unit).toBe("");
    // Absent entirely, which is every draft written before this field existed.
    expect(parseHomeOnboardingDraft(stored({ unit: undefined }), NOW)?.unit).toBe(
      ""
    );
  });

  it("counts a lone unit as something worth restoring", () => {
    const onlyUnit = stored({
      step: "address",
      street: "",
      unit: "4B",
      zip: "",
      fullName: "",
      addressLine1: "",
      facts: null,
    });
    expect(parseHomeOnboardingDraft(onlyUnit, NOW)?.unit).toBe("4B");
  });
});
