import { describe, expect, it } from "vitest";
import { claimAddressGate, type ClaimGateFacts } from "./parcelGate";
import { shouldRecordOwnershipCheck } from "./ownershipMatch";

// The claim-time gate, exercised for real rather than by matching source text.
// claimPropertyAction itself cannot be imported here (it pulls in
// next/headers, redirect and the server Supabase client), which is exactly why
// the decision was lifted out into parcelGate.ts.

const found: ClaimGateFacts = { source: "rentcast" };
const missing: ClaimGateFacts = { source: "none" };
const outage: ClaimGateFacts = { source: "unavailable" };

describe("claimAddressGate on an unedited address", () => {
  const base = { hasRecordsSource: true, addressEdited: false, relookupBlocked: false };

  it("lets a found address through", () => {
    expect(claimAddressGate({ ...base, facts: found })).toEqual({
      action: "continue",
    });
  });

  it("refuses an address the records source says does not exist", () => {
    expect(claimAddressGate({ ...base, facts: missing })).toEqual({
      action: "refuse",
      reason: "not_found",
    });
  });

  it("lets an outage through instead of calling the home fake", () => {
    // The 2026-08-24 regression, as a test: a bad key answered 401 for every
    // real address, and treating that as "no such address" refused every
    // signup for a day.
    expect(claimAddressGate({ ...base, facts: outage })).toEqual({
      action: "continue",
    });
  });

  it("lets a lookup that threw through, for the same reason", () => {
    expect(claimAddressGate({ ...base, facts: null })).toEqual({
      action: "continue",
    });
  });
});

describe("claimAddressGate on an edited street", () => {
  const base = { hasRecordsSource: true, addressEdited: true, relookupBlocked: false };

  it("refuses a street the re-lookup could not find", () => {
    expect(claimAddressGate({ ...base, facts: missing })).toEqual({
      action: "refuse",
      reason: "not_found",
    });
  });

  it("continues when the re-lookup hit an outage", () => {
    expect(claimAddressGate({ ...base, facts: outage })).toEqual({
      action: "continue",
    });
  });

  it("refuses when the rate limiter blocked the re-lookup entirely", () => {
    // Nothing has EVER looked at this string: the Continue step verified a
    // different one and the re-lookup never ran. Storing it would create a
    // home out of unverified typing, so this is the one "we couldn't check"
    // that is not tolerant.
    expect(
      claimAddressGate({ ...base, relookupBlocked: true, facts: null })
    ).toEqual({ action: "refuse", reason: "lookup_blocked" });
  });

  it("still refuses a blocked re-lookup even if stale facts are lying around", () => {
    expect(
      claimAddressGate({ ...base, relookupBlocked: true, facts: found })
    ).toEqual({ action: "refuse", reason: "lookup_blocked" });
  });
});

describe("claimAddressGate with no records source configured", () => {
  it("never refuses, because nothing was ever looked up", () => {
    for (const facts of [found, missing, outage, null]) {
      expect(
        claimAddressGate({
          hasRecordsSource: false,
          addressEdited: false,
          relookupBlocked: false,
          facts,
        })
      ).toEqual({ action: "continue" });
    }
  });

  it("does not refuse a blocked re-lookup either, with no source to check against", () => {
    expect(
      claimAddressGate({
        hasRecordsSource: false,
        addressEdited: true,
        relookupBlocked: true,
        facts: null,
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
  it("records a real record and a real miss", () => {
    expect(shouldRecordOwnershipCheck({ source: "rentcast" })).toBe(true);
    expect(shouldRecordOwnershipCheck({ source: "none" })).toBe(true);
  });

  it("records NOTHING when the records source was unreachable", () => {
    expect(shouldRecordOwnershipCheck({ source: "unavailable" })).toBe(false);
  });

  it("records nothing when there was no lookup to speak of", () => {
    expect(shouldRecordOwnershipCheck(null)).toBe(false);
    expect(shouldRecordOwnershipCheck(undefined)).toBe(false);
  });
});
