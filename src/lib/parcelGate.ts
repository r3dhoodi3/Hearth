// The claim-time address gate, as pure logic.
//
// claimPropertyAction (src/app/onboarding/actions.ts) decides three ways on
// the address being claimed, and getting that decision wrong is invisible: a
// wrong branch still compiles, still passes every other test, and still works
// perfectly while the sources are up. On 2026-08-24 a bad RentCast key made
// the whole thing refuse every real address in the launch area for a day,
// because a lookup that could not run was being read as "this address does not
// exist".
//
// So the decision lives here, apart from the action's 600 lines of FormData
// handling and DB writes, where it can be exercised directly.
//
// WHAT CHANGED ON 2026-08-28. This gate used to refuse on a RentCast miss:
// source "none" meant "the county has no such address", and that was the only
// thing keeping "123 Fake St" from becoming a home. Measuring RentCast's real
// coverage killed that rule - four plausible Orange County addresses each came
// back a hard 404, so the miss was as often a gap in one vendor's data as it
// was a fabricated address, and refusing on it locks out real homeowners. A
// miss now walks on to manual entry with no parcel facts attached.
//
// The fake-address job moved to the geocoder instead
// (src/lib/addressVerify.ts): OSM answers "is there a building here", which is
// the actual question, and RentCast answers "what does the assessor know about
// it", which is not. `addressVerdict` below is that answer.

import type { AddressVerdict } from "@/lib/addressVerify";

export type ClaimGateDecision =
  // Nothing stands in the way of creating this home.
  | { action: "continue" }
  // The geocoder offered addresses and none of them is this one.
  | { action: "refuse"; reason: "no_suggestion_match" }
  // The street was edited and we could not spend a lookup to check the new
  // one, so we have no idea what is being claimed.
  | { action: "refuse"; reason: "lookup_blocked" };

export function claimAddressGate(input: {
  // Is a records source configured at all? With no RENTCAST_API_KEY nothing
  // was ever looked up, so a blocked re-lookup is not a thing that can happen.
  hasRecordsSource: boolean;
  // Did the homeowner change the street after the Continue step looked it up?
  addressEdited: boolean;
  // Was the re-lookup of that edited street refused by the rate limiter?
  relookupBlocked: boolean;
  // Does the geocoder know this street address? See src/lib/addressVerify.ts.
  addressVerdict: AddressVerdict;
}): ClaimGateDecision {
  const { hasRecordsSource, addressEdited, relookupBlocked, addressVerdict } =
    input;

  // An edited street whose re-lookup the limiter refused: nothing has spent a
  // records call on this string, so no parcel facts can be attached to it and
  // the claim would be built out of typing alone. Kept as a refusal because
  // the limiter only ever blocks someone who has already looked up ten
  // addresses this hour, which no real signup does.
  if (hasRecordsSource && addressEdited && relookupBlocked) {
    return { action: "refuse", reason: "lookup_blocked" };
  }

  // The ONE refusal about the address itself, and note what it is not
  // conditioned on: the records source plays no part. "unavailable" (the
  // geocoder was down, or answered nothing usable) continues, because "we
  // couldn't check" has never been "this address does not exist" - that
  // conflation is the 2026-08-24 outage, and repeating it with a different
  // vendor would be the same bug wearing a hat.
  if (addressVerdict === "no_match") {
    return { action: "refuse", reason: "no_suggestion_match" };
  }

  return { action: "continue" };
}
