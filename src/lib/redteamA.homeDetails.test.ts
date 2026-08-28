import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundedNumber } from "@/lib/formFields";

// RED-TEAM A (2026-08-28): two things the new /home-details editor gets wrong.
//
// 1. BATHROOMS ACCEPTS A VALUE THE COLUMN CANNOT HOLD.
//    properties.baths is `numeric(3,1)` (migration 0001): three digits of
//    precision, one of them after the point, so the largest storable value is
//    99.9. updatePropertyAction validates with `boundedNumber(rawBaths, 0,
//    100)` (src/app/(app)/profile/actions.ts:522), which passes 100 and passes
//    99.95 (Postgres rounds it to 100.0 on the way in). Either one reaches
//    Postgres as 22003, "numeric field value out of range", and the owner is
//    told "Couldn't save your home details just now. Please try again." on
//    every retry, with no hint which box is wrong - and their other edits in
//    the same submit are lost with it.
//
//    Repro: /home-details, Bathrooms = 100, Save.
//    Fix: bound baths at 99.9, and say so in the error copy.
//
// 2. A HOUSEHOLD MEMBER'S SAVE IS A SILENT NO-OP.
//    getActiveProperty() returns a home the caller is an ACTIVE MEMBER of as
//    well as one they own ("properties member select", migration 0051), but
//    the only UPDATE policy on properties is "properties owner update"
//    (user_id = auth.uid(), migration 0002). updatePropertyAction runs its
//    update through the member's own session client, so RLS filters the row
//    out: zero rows matched, PostgREST returns no error, and the action falls
//    through to setFlash("Home details saved") + ok(). The member is told the
//    save worked and nothing changed.
//
//    refreshMarketValueAction (src/app/(app)/value/actions.ts) has the same
//    shape and costs money on the way: a Plus household member passes
//    hasPlus(), spends an AVM budget slot, bills RentCast on a cache miss,
//    writes nothing, and gets a success.
//
//    Fix: either check `property.user_id === user.id` before the update in
//    both actions and say plainly that only the home's owner can edit it, or
//    add a member UPDATE policy if members are meant to be able to.

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const profileActions = src("src/app/(app)/profile/actions.ts");
const valueActions = src("src/app/(app)/value/actions.ts");

describe("red-team A: home details bathrooms vs numeric(3,1)", () => {
  it("rejects a bathroom count the column cannot store", () => {
    // As originally written this called boundedNumber("100", 0, 100), i.e. the
    // helper with the OLD ceiling, which returns 100 no matter what the action
    // does - an assertion no fix could ever satisfy. The real contract is the
    // one below: at the column's ceiling, an overflowing value is refused
    // before it can reach Postgres as 22003, and the largest storable value
    // still gets through. The source-level check that the action actually
    // passes 99.9 is the next test.
    expect(
      boundedNumber("100", 0, 99.9),
      "100 overflows properties.baths numeric(3,1) and surfaces as an unexplained save failure"
    ).toBeNull();
    // 99.95 rounds to 100.0 on the way in, so it overflows too.
    expect(boundedNumber("99.95", 0, 99.9)).toBeNull();
    expect(boundedNumber("99.9", 0, 99.9)).toBe(99.9);
    expect(boundedNumber("2.5", 0, 99.9)).toBe(2.5);
  });

  it("bounds baths at the column's real ceiling", () => {
    expect(
      /boundedNumber\(\s*rawBaths\s*,\s*0\s*,\s*99\.9\s*\)/.test(profileActions),
      "updatePropertyAction should bound baths at 99.9 (numeric(3,1)), not 100"
    ).toBe(true);
  });
});

describe("red-team A: writes to a home the caller only belongs to", () => {
  it("updatePropertyAction refuses when the caller is not the home's owner", () => {
    expect(
      /property\.user_id\s*!==?\s*user\.id|owns?Property|property\.user_id\s*===/.test(
        profileActions.slice(profileActions.indexOf("updatePropertyAction"))
      ),
      "updatePropertyAction writes through the caller's session client to a property getActiveProperty may have returned by MEMBERSHIP; RLS silently matches zero rows and the action still reports success"
    ).toBe(true);
  });

  it("refreshMarketValueAction refuses when the caller is not the home's owner", () => {
    expect(
      /property\.user_id\s*!==?\s*user\.id|owns?Property|property\.user_id\s*===/.test(
        valueActions.slice(valueActions.indexOf("refreshMarketValueAction"))
      ),
      "refreshMarketValueAction bills RentCast for a household member and then writes nothing, because only 'properties owner update' exists"
    ).toBe(true);
  });
});
