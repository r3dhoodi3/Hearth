import "server-only";
import { stripe } from "@/lib/stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import { reservedSessionId, reservedSessionRef } from "@/lib/promoClaimRef";

type Admin = ReturnType<typeof createAdminClient>;

// What a second click on "Start my free 3 day trial" should do when this
// account already holds its one promo_claims reservation.
//
// - "resume": the reservation is held by a Stripe Checkout session that is
//   still open. Send the buyer back to that same session. Nothing new is
//   created, so there is no second trial and no second subscription, and the
//   session they land on quotes the same terms the page promised them.
// - "reclaimed": the session that held it is gone (expired, or it was for a
//   different cadence), and THIS request has taken the reservation over. The
//   caller may offer the trial again.
// - "held": somebody else holds it, or we could not tell. No offer. This is
//   the fail-closed answer, and it is what a concurrent second tab gets while
//   the first tab's session is still being created.
export type ReservationOutcome =
  | { kind: "resume"; url: string }
  | { kind: "reclaimed" }
  | { kind: "held" };

// Decide what a losing claim_promo call means for THIS request.
//
// Called only after claim_promo returned false, i.e. the row already exists.
// The whole question is which of three stories that row is telling, and the
// `ref` column is the only thing that can answer it (see promoClaimRef.ts):
//
//   bare marker      an attempt from milliseconds ago is still creating its
//                    session. Not ours. Fail closed - this is exactly the
//                    two-tabs-at-once case the reservation exists to stop.
//   converted:...    already spent on a real subscription. Never again.
//   marker:cs_...    a checkout we opened. Ask Stripe how it ended.
//
// Everything here is best effort and never throws: the worst outcome is
// "held", which is today's behaviour (charged today, with the Stripe page and
// the consent record both saying so).
export async function reclaimCheckoutReservation(
  admin: Admin,
  opts: {
    userId: string;
    promoKey: string;
    reservationRef: string;
    // The cadence this click is buying. A session opened for a different one
    // must never be resumed, or the buyer lands on a checkout for the plan
    // they just changed their mind about.
    plan: string;
  }
): Promise<ReservationOutcome> {
  try {
    const { data: row, error } = await admin
      .from("promo_claims")
      .select("ref")
      .eq("user_id", opts.userId)
      .eq("promo_key", opts.promoKey)
      .maybeSingle();
    // An unreadable ledger must never be a way to get a second offer.
    if (error || !row) return { kind: "held" };

    const ref = row.ref ?? "";
    const sessionId = reservedSessionId(opts.reservationRef, ref);
    if (!sessionId) return { kind: "held" };

    let session: Awaited<
      ReturnType<typeof stripe.checkout.sessions.retrieve>
    > | null = null;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      // Stripe unreachable, or the session id is not one of ours any more.
      return { kind: "held" };
    }

    // Completed: this reservation bought something. The webhook stamps
    // converted:<subscription id> on completion, but a redelivery could be
    // late, so the session's own status is checked first and is authoritative.
    if (session?.status === "complete") return { kind: "held" };

    const samePlan =
      typeof session?.metadata?.plan === "string"
        ? session.metadata.plan === opts.plan
        : true;
    if (session?.status === "open" && session.url && samePlan) {
      return { kind: "resume", url: session.url };
    }

    // Open but for another cadence: close it before taking the reservation
    // over, so two live sessions can never both convert.
    if (session?.status === "open") {
      try {
        await stripe.checkout.sessions.expire(sessionId);
      } catch {
        // If it cannot be closed, do not take the reservation over either.
        return { kind: "held" };
      }
    }

    // Expired (or just expired by us): the reservation is unspent and free to
    // reuse. The take-over is a CONDITIONAL update on the exact ref we read, so
    // it is as atomic as claim_promo's insert was: two requests racing here
    // both match the same old ref, Postgres serializes them on the row, and the
    // loser re-checks the predicate against the winner's new ref and updates
    // nothing.
    const { data: taken, error: takeError } = await admin
      .from("promo_claims")
      .update({ ref: opts.reservationRef, claimed_at: new Date().toISOString() })
      .eq("user_id", opts.userId)
      .eq("promo_key", opts.promoKey)
      .eq("ref", ref)
      .select("promo_key");
    if (takeError || !taken || taken.length === 0) return { kind: "held" };
    return { kind: "reclaimed" };
  } catch (err) {
    console.error("promo reservation reclaim threw:", err);
    return { kind: "held" };
  }
}

// Record WHICH Stripe Checkout session now holds the reservation, right after
// it is created. Without this the row is a bare marker forever, and the next
// click cannot tell an abandoned checkout apart from a concurrent one - which
// is the bug that made every retry fail with a Stripe idempotency error.
//
// Guarded on the bare marker so it can only ever write over the reservation
// this request is holding: never over a converted claim, never over another
// attempt's session. Best effort; a failure costs the buyer a retry, not a
// checkout.
export async function markReservationSession(
  admin: Admin,
  opts: {
    userId: string;
    promoKey: string;
    reservationRef: string;
    sessionId: string;
  }
): Promise<void> {
  try {
    const { error } = await admin
      .from("promo_claims")
      .update({
        ref: reservedSessionRef(opts.reservationRef, opts.sessionId),
      })
      .eq("user_id", opts.userId)
      .eq("promo_key", opts.promoKey)
      .eq("ref", opts.reservationRef);
    if (error) {
      console.error(
        "promo_claims session marker failed for",
        opts.promoKey,
        error.message ?? error
      );
    }
  } catch (err) {
    console.error("promo_claims session marker threw:", err);
  }
}
