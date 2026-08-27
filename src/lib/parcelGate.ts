// The claim-time address gate, as pure logic.
//
// claimPropertyAction (src/app/onboarding/actions.ts) decides three ways on
// the address being claimed, and getting that decision wrong is invisible: a
// wrong branch still compiles, still passes every other test, and still works
// perfectly while RentCast is up. On 2026-08-24 a bad API key made the whole
// thing refuse every real address in the launch area for a day, because a
// lookup that could not run was being read as "this address does not exist".
//
// So the decision lives here, apart from the action's 600 lines of FormData
// handling and DB writes, where it can be exercised directly.

export type ClaimGateFacts = {
  source: "rentcast" | "none" | "unavailable";
} | null;

export type ClaimGateDecision =
  // Nothing stands in the way of creating this home.
  | { action: "continue" }
  // The records source answered and has no such address.
  | { action: "refuse"; reason: "not_found" }
  // The street was edited and we could not spend a lookup to check the new
  // one, so we have no idea what is being claimed.
  | { action: "refuse"; reason: "lookup_blocked" };

export function claimAddressGate(input: {
  // Is a records source configured at all? With no RENTCAST_API_KEY nothing
  // was ever looked up, so there is nothing to refuse on.
  hasRecordsSource: boolean;
  // Did the homeowner change the street after the Continue step looked it up?
  addressEdited: boolean;
  // Was the re-lookup of that edited street refused by the rate limiter?
  relookupBlocked: boolean;
  // What the lookup returned, or null if it could not run or threw.
  facts: ClaimGateFacts;
}): ClaimGateDecision {
  const { hasRecordsSource, addressEdited, relookupBlocked, facts } = input;

  if (!hasRecordsSource) return { action: "continue" };

  // An edited street whose re-lookup the limiter refused is the one case where
  // "we couldn't check" must NOT be tolerant. Every other unchecked path is
  // about an address the Continue step already verified; this one is about a
  // string typed after that check, which nothing has ever looked at. Letting
  // it through stores whatever was typed as a real home.
  if (addressEdited && relookupBlocked) {
    return { action: "refuse", reason: "lookup_blocked" };
  }

  // Only an explicit "none" from a source that actually answered refuses.
  // "unavailable" (401/429/5xx/timeout - see ParcelFacts in src/lib/parcel.ts)
  // and null (the lookup threw) are both "we couldn't check", which is not
  // "this address does not exist".
  if (facts && facts.source === "none") {
    return { action: "refuse", reason: "not_found" };
  }

  return { action: "continue" };
}
