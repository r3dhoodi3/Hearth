import { describe, it, expect, beforeEach, vi } from "vitest";
import { PLUS_RESERVATION_REF, convertedRef, reservedSessionRef } from "./promoClaimRef";

// The module imports "server-only" (through the Stripe client) which cannot be
// resolved under vitest, and the Stripe client itself throws without a secret
// key. Both are stubbed so the real reservation logic can be driven.
vi.mock("server-only", () => ({}));

const retrieve = vi.fn();
const expire = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        retrieve: (...args: unknown[]) => retrieve(...args),
        expire: (...args: unknown[]) => expire(...args),
      },
    },
  },
}));

const { reclaimCheckoutReservation, markReservationSession } = await import(
  "./checkoutReservation"
);

// The thin slice of the PostgREST builder this module uses:
//   .from(t).select(c).eq().eq().maybeSingle()
//   .from(t).update(p).eq().eq().eq().select(c)
let row: { ref: string | null } | null = null;
let readError: { message: string } | null = null;
let updates: { payload: Record<string, unknown>; filters: [string, unknown][] }[] =
  [];
// Rows the conditional take-over update reports back. Empty means "the
// predicate matched nothing", i.e. somebody else got there first.
let updateReturns: unknown[] = [];

function fakeAdmin() {
  return {
    from() {
      const filters: [string, unknown][] = [];
      let payload: Record<string, unknown> | null = null;
      const api: Record<string, unknown> = {};
      Object.assign(api, {
        select: () => {
          if (payload) {
            updates.push({ payload, filters });
            return Promise.resolve({ data: updateReturns, error: null });
          }
          return api;
        },
        update: (p: Record<string, unknown>) => {
          payload = p;
          return api;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return api;
        },
        maybeSingle: () =>
          Promise.resolve({ data: row, error: readError }),
        // markReservationSession awaits the builder without .select()
        then: (resolve: (v: unknown) => unknown) => {
          if (payload) updates.push({ payload, filters });
          return Promise.resolve({ error: null }).then(resolve);
        },
      });
      return api;
    },
  } as never;
}

const opts = {
  userId: "user_1",
  promoKey: "plus_trial",
  reservationRef: PLUS_RESERVATION_REF,
  plan: "weekly",
};

beforeEach(() => {
  row = null;
  readError = null;
  updates = [];
  updateReturns = [];
  retrieve.mockReset();
  expire.mockReset();
});

describe("reclaimCheckoutReservation", () => {
  it("resumes the open checkout the buyer backed out of", async () => {
    // THE LIVE BUG. The buyer opened Stripe Checkout, pressed back, and clicked
    // again: claim_promo loses to their own reservation, and the old code built
    // a no-trial body under the same idempotency key, which Stripe refused.
    // Now they simply go back to the session they already have.
    row = { ref: reservedSessionRef(PLUS_RESERVATION_REF, "cs_1") };
    retrieve.mockResolvedValue({
      status: "open",
      url: "https://checkout.stripe.com/c/cs_1",
      metadata: { plan: "weekly" },
    });

    const outcome = await reclaimCheckoutReservation(fakeAdmin(), opts);

    expect(outcome).toEqual({
      kind: "resume",
      url: "https://checkout.stripe.com/c/cs_1",
    });
    // Nothing is taken over, because nothing was abandoned.
    expect(updates).toEqual([]);
  });

  it("takes an expired reservation over so the free days come back", async () => {
    row = { ref: reservedSessionRef(PLUS_RESERVATION_REF, "cs_1") };
    retrieve.mockResolvedValue({ status: "expired", metadata: { plan: "weekly" } });
    updateReturns = [{ promo_key: "plus_trial" }];

    const outcome = await reclaimCheckoutReservation(fakeAdmin(), opts);

    expect(outcome).toEqual({ kind: "reclaimed" });
    // The take-over is conditional on the exact ref that was read, which is
    // what keeps two racing reclaims down to one winner.
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.ref).toBe(PLUS_RESERVATION_REF);
    expect(updates[0].filters).toContainEqual([
      "ref",
      reservedSessionRef(PLUS_RESERVATION_REF, "cs_1"),
    ]);
  });

  it("loses the take-over race gracefully", async () => {
    row = { ref: reservedSessionRef(PLUS_RESERVATION_REF, "cs_1") };
    retrieve.mockResolvedValue({ status: "expired" });
    updateReturns = []; // another request updated the ref first

    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });
  });

  it("never gives a second trial to somebody who already converted", async () => {
    row = { ref: convertedRef("sub_1") };
    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });
    expect(retrieve).not.toHaveBeenCalled();

    // And the same when the ledger stamp is late but Stripe already knows.
    row = { ref: reservedSessionRef(PLUS_RESERVATION_REF, "cs_1") };
    retrieve.mockResolvedValue({ status: "complete" });
    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });
    expect(updates).toEqual([]);
  });

  it("stands down for a bare marker, i.e. a second tab mid-checkout", async () => {
    row = { ref: PLUS_RESERVATION_REF };
    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("closes an open session for another cadence before taking it over", async () => {
    row = { ref: reservedSessionRef(PLUS_RESERVATION_REF, "cs_1") };
    retrieve.mockResolvedValue({
      status: "open",
      url: "https://checkout.stripe.com/c/cs_1",
      metadata: { plan: "monthly" },
    });
    expire.mockResolvedValue({});
    updateReturns = [{ promo_key: "plus_trial" }];

    const outcome = await reclaimCheckoutReservation(fakeAdmin(), opts);

    expect(expire).toHaveBeenCalledWith("cs_1");
    expect(outcome).toEqual({ kind: "reclaimed" });
  });

  it("fails closed when the ledger or Stripe cannot be read", async () => {
    readError = { message: "boom" };
    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });

    readError = null;
    row = null; // no row at all
    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });

    row = { ref: reservedSessionRef(PLUS_RESERVATION_REF, "cs_1") };
    retrieve.mockRejectedValue(new Error("stripe down"));
    expect(await reclaimCheckoutReservation(fakeAdmin(), opts)).toEqual({
      kind: "held",
    });
  });
});

describe("markReservationSession", () => {
  it("writes the session id over the bare marker only", async () => {
    await markReservationSession(fakeAdmin(), {
      userId: "user_1",
      promoKey: "plus_trial",
      reservationRef: PLUS_RESERVATION_REF,
      sessionId: "cs_2",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].payload.ref).toBe(
      reservedSessionRef(PLUS_RESERVATION_REF, "cs_2")
    );
    // Guarded on the bare marker: it can never write over a converted claim or
    // another attempt's session.
    expect(updates[0].filters).toContainEqual(["ref", PLUS_RESERVATION_REF]);
    expect(updates[0].filters).toContainEqual(["user_id", "user_1"]);
  });
});
