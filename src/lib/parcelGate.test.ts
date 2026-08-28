import { describe, expect, it } from "vitest";
import { claimAddressGate } from "./parcelGate";
import { shouldRecordOwnershipCheck } from "./ownershipMatch";

// The claim-time gate, exercised for real rather than by matching source text.
// claimPropertyAction itself cannot be imported here (it pulls in
// next/headers, redirect and the server Supabase client), which is exactly why
// the decision was lifted out into parcelGate.ts.

const base = {
  hasRecordsSource: true,
  addressEdited: false,
  relookupBlocked: false,
};

describe("claimAddressGate on the geocoder verdict", () => {
  it("lets an address the geocoder knows through", () => {
    expect(claimAddressGate({ ...base, addressVerdict: "match" })).toEqual({
      action: "continue",
    });
  });

  it("refuses an address the geocoder offered no match for", () => {
    // The one refusal about the address itself. Photon answers "123 Fake
    // Street" with fifteen real addresses on other streets, none of them the
    // one typed - that is what a made-up address looks like from here.
    expect(claimAddressGate({ ...base, addressVerdict: "no_match" })).toEqual({
      action: "refuse",
      reason: "no_suggestion_match",
    });
  });

  it("lets a geocoder outage through instead of calling the home fake", () => {
    // The 2026-08-24 regression, as a test, one vendor over: treating "we
    // couldn't check" as "no such address" refused every real signup for a
    // day. Photon has no uptime promise at all, so this is the likelier of
    // the two to happen again.
    expect(
      claimAddressGate({ ...base, addressVerdict: "unavailable" })
    ).toEqual({ action: "continue" });
  });
});

describe("claimAddressGate no longer decides on the records source", () => {
  // 2026-08-28: a RentCast miss used to refuse here. Four plausible Orange
  // County addresses measured straight against the API each came back a hard
  // 404, so a miss is as often a gap in one vendor's data as a fabricated
  // address, and refusing on it locks out real homeowners. The gate does not
  // see the records result at all now - these cases are about the geocoder
  // verdict alone.
  it("continues a records miss the geocoder recognizes", () => {
    expect(claimAddressGate({ ...base, addressVerdict: "match" })).toEqual({
      action: "continue",
    });
  });

  it("continues with no records source configured, when the address checks out", () => {
    expect(
      claimAddressGate({
        ...base,
        hasRecordsSource: false,
        addressVerdict: "match",
      })
    ).toEqual({ action: "continue" });
  });

  it("still refuses a fake address with no records source configured", () => {
    // The geocoder check is independent of RENTCAST_API_KEY, so an
    // environment with no records source is no longer an open door.
    expect(
      claimAddressGate({
        ...base,
        hasRecordsSource: false,
        addressVerdict: "no_match",
      })
    ).toEqual({ action: "refuse", reason: "no_suggestion_match" });
  });
});

describe("claimAddressGate on an edited street", () => {
  const edited = { ...base, addressEdited: true };

  it("continues an edited street the geocoder knows", () => {
    expect(claimAddressGate({ ...edited, addressVerdict: "match" })).toEqual({
      action: "continue",
    });
  });

  it("refuses when the rate limiter blocked the re-lookup entirely", () => {
    // No records call has ever been spent on this string: the Continue step
    // checked a different one and the re-lookup never ran, so there are no
    // facts to attach to it. The limiter only blocks someone who has already
    // looked up ten addresses this hour, which no real signup does.
    expect(
      claimAddressGate({
        ...edited,
        relookupBlocked: true,
        addressVerdict: "match",
      })
    ).toEqual({ action: "refuse", reason: "lookup_blocked" });
  });

  it("reports lookup_blocked ahead of no_suggestion_match", () => {
    // Both are true here. The limiter reason is the actionable one - "try
    // again in a bit" is something the homeowner can do, and it is the
    // accurate description of what stopped them.
    expect(
      claimAddressGate({
        ...edited,
        relookupBlocked: true,
        addressVerdict: "no_match",
      })
    ).toEqual({ action: "refuse", reason: "lookup_blocked" });
  });

  it("ignores a blocked re-lookup when there is no records source to block", () => {
    expect(
      claimAddressGate({
        ...edited,
        hasRecordsSource: false,
        relookupBlocked: true,
        addressVerdict: "match",
      })
    ).toEqual({ action: "continue" });
  });
});

describe("whether an ownership check gets recorded at all", () => {
  // record_ownership_check (migration 0095) stamps ownership_checked_at, and a
  // null ownership_checked_at is the ONLY thing that keeps the lazy re-check
  // on first job post eligible to run. Recording during an outage therefore
  // freezes "unverified" in permanently, and the home's job posts never get
  // the fan-out a verified home gets.
  it("records a real record", () => {
    expect(shouldRecordOwnershipCheck({ source: "rentcast" })).toBe(true);
  });

  it("records NOTHING for a records miss", () => {
    // Changed 2026-08-28, along with the gate above. A miss carries no owner
    // of record, so there is no verdict to keep - and now that a miss reaches
    // the claim at all (it used to be refused outright), recording one would
    // burn the retry on an address RentCast may simply not have indexed yet.
    expect(shouldRecordOwnershipCheck({ source: "none" })).toBe(false);
  });

  it("records NOTHING when the records source was unreachable", () => {
    expect(shouldRecordOwnershipCheck({ source: "unavailable" })).toBe(false);
  });

  it("records nothing when there was no lookup to speak of", () => {
    expect(shouldRecordOwnershipCheck(null)).toBe(false);
    expect(shouldRecordOwnershipCheck(undefined)).toBe(false);
  });
});
