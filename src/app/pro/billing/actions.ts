"use server";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getCurrentContractor } from "@/lib/contractor";
import { createAdminClient } from "@/lib/supabase/admin";
import { setFlash } from "@/lib/flash";
import {
  checkoutIdempotencyBucket,
  checkoutIdempotencyKey,
} from "@/lib/checkoutIdempotency";
import { MAX_DEPOSIT_CENTS } from "@/lib/constants";

const siteUrl = () =>
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Deposit velocity limits (HIGH-30). The $2,000-per-session cap alone bounds
// nothing an abuser cares about: a stolen card can open ten sessions in an
// hour, deposit, spend the balance on leads, then dispute every charge. These
// bound how fast money can be pushed into one wallet before any of it settles.
//   - a hard count of deposits started per 24h, per contractor, and
//   - a rolling 24h ceiling on the dollars that have actually settled into the
//     wallet, so many small deposits cannot add up past the same line.
// A contractor with an OPEN chargeback (has_open_chargeback, migration 0132)
// cannot deposit at all until support clears it.
const DEPOSIT_MAX_PER_DAY = 3;
const DEPOSIT_WINDOW_SECONDS = 24 * 60 * 60;
const DEPOSIT_DAILY_CENTS_CEILING = 500_000; // $5,000 of settled deposits / 24h

// Deposit cash into the wallet. The bonus tier is computed + granted in the DB
// (apply_deposit) when the Stripe webhook confirms payment.
export async function depositAction(formData: FormData) {
  const dollars = Number(formData.get("amount"));
  const cents = Math.round(dollars * 100);
  if (!cents || cents < 500) redirect("/pro/billing"); // $5 minimum to deposit
  // $2,000 maximum per deposit, shared with the webhook that does the actual
  // crediting (MAX_DEPOSIT_CENTS in src/lib/constants.ts) so the two ends can
  // never drift apart. This end bounds what our own form may ask Stripe for;
  // the webhook end bounds what the ledger will accept, reading Stripe's own
  // amount_total rather than anything that rode along in metadata. It exists to
  // bound how much a single chargeback can claw back through, on top of the
  // reverse_deposit wallet-reversal handling in the Stripe webhook.
  if (cents > MAX_DEPOSIT_CENTS) redirect("/pro/billing");

  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  // ---- Velocity + freeze guards, before Stripe is ever asked for a session
  // (HIGH-30). All three read through the service-role admin client, since the
  // relevant tables/RPCs are service-role only. Each flag is computed inside a
  // try so a redirect() (which works by throwing) is never swallowed by the
  // catch: the redirects happen AFTER the reads.
  const admin = createAdminClient();

  // 1. An open payment dispute freezes ALL spending, deposits included. Refuse
  // on a definite "true". On an error we log and continue: has_open_chargeback
  // itself fails open (a DB without migration 0132 returns false), and the
  // rate limiter below is the guaranteed fail-closed gate, so a transient RPC
  // hiccup here must not become the thing that blocks every legit deposit.
  let frozen = false;
  try {
    // Cast: has_open_chargeback (migration 0132) is service-role only and not
    // in the generated RPC types, the same reason the webhook reaches for it
    // through an untyped client.
    const { data, error } = await (admin as any).rpc("has_open_chargeback", {
      p_contractor: contractor.id,
    });
    if (error) {
      console.error("has_open_chargeback check failed:", error.message ?? error);
    } else {
      frozen = data === true;
    }
  } catch (err) {
    console.error("has_open_chargeback check threw:", err);
  }
  if (frozen) {
    await setFlash(
      "There's an open payment dispute on your account, so deposits are paused until it's resolved. Contact support if you think this is a mistake.",
      "error"
    );
    redirect("/pro/billing");
  }

  // 2. Rolling 24h dollar ceiling on deposits that have actually SETTLED into
  // this wallet (wallet_transactions type 'deposit', migration 0010). Read
  // only, best-effort: an unreadable ledger falls through to the hard count cap
  // below rather than blocking. Settled-only leaves a small in-flight window,
  // but the count cap bounds how many sessions can be opened in that window.
  let overCeiling = false;
  try {
    const since = new Date(
      Date.now() - DEPOSIT_WINDOW_SECONDS * 1000
    ).toISOString();
    const { data: wallet } = await (admin as any)
      .from("wallets")
      .select("id")
      .eq("contractor_id", contractor.id)
      .maybeSingle();
    if (wallet?.id) {
      const { data: rows } = await (admin as any)
        .from("wallet_transactions")
        .select("cash_delta_cents")
        .eq("wallet_id", wallet.id)
        .eq("type", "deposit")
        .gte("created_at", since);
      const priorCents = ((rows as any[]) ?? []).reduce(
        (sum, r) => sum + Math.max(Number(r.cash_delta_cents) || 0, 0),
        0
      );
      overCeiling = priorCents + cents > DEPOSIT_DAILY_CENTS_CEILING;
    }
  } catch (err) {
    console.error("deposit dollar-ceiling read threw:", err);
  }
  if (overCeiling) {
    await setFlash(
      "That would go over the daily deposit limit. Try a smaller amount, or come back tomorrow.",
      "error"
    );
    redirect("/pro/billing");
  }

  // 3. Hard count cap per 24h, FAIL CLOSED. This is the guaranteed gate: it
  // increments the counter (rate_limit_hit, migration 0070) and proceeds ONLY
  // on an explicit within-limit answer. A false (over the limit), a null (RPC
  // error), or a throw all refuse - because letting an abuser through on a
  // limiter outage is the failure that costs real money, while a legit pro who
  // is briefly refused just tries again. Incremented LAST, so a refusal by the
  // freeze or the dollar ceiling above never burns a slot.
  let withinCountLimit = false;
  try {
    const { data, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: `deposit:${contractor.id}`,
      p_limit: DEPOSIT_MAX_PER_DAY,
      p_window_seconds: DEPOSIT_WINDOW_SECONDS,
    });
    if (error) {
      console.error("deposit rate_limit_hit failed:", error.message ?? error);
    } else {
      withinCountLimit = data === true;
    }
  } catch (err) {
    console.error("deposit rate_limit_hit threw:", err);
  }
  if (!withinCountLimit) {
    await setFlash(
      "You've started several deposits today already. Please try again tomorrow.",
      "error"
    );
    redirect("/pro/billing");
  }

  // Idempotency key on the session create (MED-14): stable per contractor +
  // amount + a 5-minute bucket, so a double-submit (a fast double tap, two
  // tabs) replays the SAME Checkout session instead of minting two, while a
  // genuine later deposit (new bucket, or a different amount) still gets a
  // fresh one. Mirrors the checkout actions' idempotency handling.
  const bucket = checkoutIdempotencyBucket();
  const idempotencyKey = checkoutIdempotencyKey({
    prefix: "deposit",
    userId: contractor.id,
    plan: "deposit",
    bucket,
    varying: { cents },
  });

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: cents,
            product_data: { name: "Hearth wallet deposit" },
          },
        },
      ],
      metadata: {
        type: "deposit",
        contractor_id: contractor.id,
        deposit_cents: String(cents),
      },
      success_url: `${siteUrl()}/pro/billing?paid=1`,
      cancel_url: `${siteUrl()}/pro/billing?canceled=1`,
    },
    { idempotencyKey }
  );

  if (session.url) redirect(session.url);
  redirect("/pro/billing");
}
