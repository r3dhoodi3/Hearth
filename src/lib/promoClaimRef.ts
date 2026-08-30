// How the `ref` column on promo_claims (migration 0071/0073) is written and
// read. The row itself is the one-per-account lock; `ref` is the note on it
// saying what that lock is currently being used for, and every checkout path
// has to agree on the wording or the lock cannot be reasoned about.
//
// Three shapes, in the order a single claim moves through them:
//
//   "plus_checkout_reservation"        reserved, no Stripe session yet
//   "plus_checkout_reservation:cs_1"   reserved, and cs_1 is the open checkout
//   "converted:sub_1"                  spent: it became a real subscription
//
// The middle shape is the one that fixes the live bug. Before it existed, a
// buyer who opened Stripe Checkout and backed out held a bare reservation that
// nothing could tell apart from a reservation another tab was holding
// mid-flight, so their next click could not safely be given the free days back.
// Recording the session id makes the difference readable: Stripe can be asked
// whether that exact session is still open, expired, or completed.
//
// Pure string helpers on purpose (no Stripe, no Supabase), so they can be unit
// tested and shared by the two checkout actions and the webhook.

// The bare reservation marker each side writes when it wins claim_promo.
export const PLUS_RESERVATION_REF = "plus_checkout_reservation";
export const PRO_RESERVATION_REF = "pro_checkout_reservation";

// Reservation marker plus the Stripe Checkout Session that now holds it.
export function reservedSessionRef(
  reservationRef: string,
  sessionId: string
): string {
  return `${reservationRef}:${sessionId}`;
}

// The session id inside a ref written by reservedSessionRef, or null when this
// ref is anything else: a bare reservation (an attempt still in flight), a
// converted claim, a backfill row, or an empty column.
export function reservedSessionId(
  reservationRef: string,
  ref: string | null | undefined
): string | null {
  if (!ref) return null;
  const prefix = `${reservationRef}:`;
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length);
  return id.length > 0 ? id : null;
}

// What the webhook stamps once a checkout actually completes. This is the
// marker that makes "has this account already spent its one offer?" answerable
// from the ledger alone, without a subscriptions row to read.
export function convertedRef(subscriptionId: string): string {
  return `converted:${subscriptionId}`;
}

export function isConvertedRef(ref: string | null | undefined): boolean {
  return Boolean(ref && ref.startsWith("converted:"));
}
