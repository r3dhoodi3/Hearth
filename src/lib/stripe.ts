// Build-time guard: this module reads STRIPE_SECRET_KEY, so importing it from
// a Client Component must fail the build, not ship the key.
import "server-only";
import Stripe from "stripe";
import { assertProductionEnvSeparation } from "@/lib/envGuard";

// Server-side Stripe client. Uses the secret key from the environment; the
// hosted-checkout flow doesn't need the publishable key.
//
// Constructed lazily on first use, NOT at import time. `new Stripe("")` throws
// ("Neither apiKey nor config.authenticator provided"), and this module is
// pulled in by src/lib/subscription.ts, which nearly every signed-in page
// imports. Eagerly constructing meant a dev machine without STRIPE_SECRET_KEY
// could not render any page at all. With the lazy client, pages that never
// touch Stripe work, and the first real Stripe call on a keyless machine
// throws a message that names the missing variable.
let client: Stripe | null = null;

function getStripe(): Stripe {
  if (!client) {
    // First server use of the Stripe secret. A live deploy still holding a
    // sk_test_ key takes no real money and reports success, so it stops here
    // rather than silently "working" (src/lib/envGuard.ts).
    assertProductionEnvSeparation();
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        "STRIPE_SECRET_KEY is not set. Billing features are unavailable until it is added to the environment."
      );
    }
    client = new Stripe(key);
  }
  return client;
}

// Same call sites as before (`stripe.subscriptions.retrieve(...)`,
// `stripe.webhooks.constructEvent(...)`): property access resolves against the
// real client, which is created on the first access.
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const real = getStripe() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as Function).bind(real) : value;
  },
});
