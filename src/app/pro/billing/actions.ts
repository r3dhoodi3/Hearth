"use server";

import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getCurrentContractor } from "@/lib/contractor";
import { MAX_DEPOSIT_CENTS } from "@/lib/constants";

const siteUrl = () =>
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

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

  const session = await stripe.checkout.sessions.create({
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
  });

  if (session.url) redirect(session.url);
  redirect("/pro/billing");
}
