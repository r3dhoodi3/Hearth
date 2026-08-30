import { stripe } from "@/lib/stripe";
import { PLUS_PLAN, extraHomeUnitPrice } from "@/lib/constants";

// Resolve the Stripe Price to bill an existing subscription with, for the Plus
// base plan and for the extra-home add-on.
//
// WHY THIS EXISTS. The plan-switch actions used to build inline `price_data`
// carrying `product: <the product the subscription item already points at>`.
// That is the only shape a subscription-item update accepts (unlike Checkout,
// price_data there takes a product ID, not product_data), and it broke live:
// the "Hearth Plus" product backing the live subscriptions had been archived in
// the connected Stripe account, and Stripe refuses to attach a new price to an
// inactive product -
//
//   "The product prod_... is marked as inactive, and thus no new subscriptions
//    can be created to any plans of this product."
//
// so every "Switch to yearly" ended in the generic "something went sideways"
// flash and yearly could not be bought at all. Reusing a product id read off
// the subscription can never be safe: whether that product is still active is
// not something the app controls.
//
// So: never reference a product we did not just prove is active. Find an active
// product tagged with our own metadata, create one if there isn't one (or if
// the only one is archived), then find-or-create an active recurring price on
// it at the exact amount and interval we mean to charge. Both lookups are
// keyed so a second call reuses what the first created instead of littering the
// account with duplicates.
//
// Setting STRIPE_PRICE_PLUS_WEEKLY / _MONTHLY / _YEARLY (and
// STRIPE_PRICE_HOME_SLOT_MONTHLY / _YEARLY) is still the cleanest setup - a
// price you created and can see in the dashboard beats one this file minted -
// and an env value always wins here. This is the fallback that has to work
// anyway, because it is what runs when the env var is missing, which is exactly
// the state live was in.

export type PlusCadence = "weekly" | "monthly" | "yearly";

// The metadata tag that makes a product ours. Looked up by, so it must never
// change without a migration of the products already carrying it.
const PLAN_META_KEY = "hearth_plan";
const PLUS_META_VALUE = "plus";
const HOME_SLOT_META_VALUE = "home_slots";

type StripeInterval = "week" | "month" | "year";

const PLUS_INTERVAL: Record<PlusCadence, StripeInterval> = {
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

// Cents, derived from PLUS_PLAN so a price edit moves this with it. A literal
// here would drift away from the number the pricing pages, the checkout, and
// the auto-renewal disclosure all read.
function plusAmountCents(cadence: PlusCadence): number {
  const dollars =
    cadence === "weekly"
      ? PLUS_PLAN.weekly
      : cadence === "yearly"
        ? PLUS_PLAN.yearly
        : PLUS_PLAN.monthly;
  return Math.round(dollars * 100);
}

// Per-process reuse. Serverless gives every instance its own copy, which is
// why the Stripe-side lookup below (not this map) is what actually keeps the
// account from filling up with duplicates; the map only saves the round trips
// within one instance.
const productCache = new Map<string, string>();
const priceCache = new Map<string, string>();

// Products cannot be filtered by metadata in a list call, and products.search
// is index-backed: a product created a moment ago is not searchable for up to a
// minute, so two calls in a row would each create one. Listing and filtering in
// memory sees a product the instant it exists. Capped at five pages so a busy
// account cannot turn this into an unbounded scan; a fresh product is created
// past that, which is wasteful but never wrong.
const MAX_PRODUCT_PAGES = 5;

async function activeProductId(
  metaValue: string,
  name: string
): Promise<string> {
  const cached = productCache.get(metaValue);
  if (cached) return cached;

  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PRODUCT_PAGES; page++) {
    const list = await stripe.products.list({
      active: true,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = list.data.find(
      (p) => p.active && p.metadata?.[PLAN_META_KEY] === metaValue
    );
    if (match) {
      productCache.set(metaValue, match.id);
      return match.id;
    }
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  // Nothing active carries the tag: either this account has never had one, or
  // the one it had was archived (the live failure). Either way a new active
  // product is the answer, and it is tagged so the next call finds it.
  const created = await stripe.products.create({
    name,
    metadata: { [PLAN_META_KEY]: metaValue },
  });
  productCache.set(metaValue, created.id);
  return created.id;
}

async function activePriceId(opts: {
  productId: string;
  unitAmount: number;
  interval: StripeInterval;
  metadata: Record<string, string>;
}): Promise<string> {
  const { productId, unitAmount, interval } = opts;
  const cacheKey = `${productId}:${unitAmount}:${interval}`;
  const cached = priceCache.get(cacheKey);
  if (cached) return cached;

  // Prices CAN be listed by product, so one page of a product we own is
  // plenty. Matched on everything that has to agree for the charge to be the
  // one we mean: currency, amount, interval, and a one-per-interval recurrence.
  const list = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  });
  const match = list.data.find(
    (p) =>
      p.active &&
      p.currency === "usd" &&
      p.unit_amount === unitAmount &&
      p.recurring?.interval === interval &&
      (p.recurring?.interval_count ?? 1) === 1
  );
  if (match) {
    priceCache.set(cacheKey, match.id);
    return match.id;
  }

  const created = await stripe.prices.create({
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval },
    product: productId,
    metadata: opts.metadata,
  });
  priceCache.set(cacheKey, created.id);
  return created.id;
}

// The Price id to put on the BASE Plus item for a cadence. Prefers the
// configured env Price; otherwise find-or-creates one on an active product.
export async function plusPriceId(cadence: PlusCadence): Promise<string> {
  const configured =
    cadence === "weekly"
      ? process.env.STRIPE_PRICE_PLUS_WEEKLY
      : cadence === "yearly"
        ? process.env.STRIPE_PRICE_PLUS_YEARLY
        : process.env.STRIPE_PRICE_PLUS_MONTHLY;
  if (configured) return configured;

  const productId = await activeProductId(PLUS_META_VALUE, "Hearth Plus");
  return activePriceId({
    productId,
    unitAmount: plusAmountCents(cadence),
    interval: PLUS_INTERVAL[cadence],
    metadata: { [PLAN_META_KEY]: PLUS_META_VALUE, hearth_cadence: cadence },
  });
}

// The Price id for the extra-home add-on at a given quantity. The add-on is
// volume priced (EXTRA_HOME), and the fallback charges a flat per-slot amount
// from the tier this quantity lands in - the same way the pre-created Stripe
// volume Price would bill it. Different quantities can therefore resolve to
// different prices; each is found-or-created once and reused after that.
export async function homeSlotPriceId(
  interval: "monthly" | "yearly",
  quantity: number
): Promise<string> {
  const configured =
    interval === "yearly"
      ? process.env.STRIPE_PRICE_HOME_SLOT_YEARLY
      : process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY;
  if (configured) return configured;

  const productId = await activeProductId(
    HOME_SLOT_META_VALUE,
    "Extra Hearth home"
  );
  return activePriceId({
    productId,
    unitAmount: Math.round(extraHomeUnitPrice(interval, quantity) * 100),
    interval: interval === "yearly" ? "year" : "month",
    metadata: {
      [PLAN_META_KEY]: HOME_SLOT_META_VALUE,
      hearth_cadence: interval,
    },
  });
}

// Test seam only: the caches above are process-lived on purpose, so a test that
// drives two different Stripe states in one file needs a way to forget.
export function __resetPlanPriceCacheForTests(): void {
  productCache.clear();
  priceCache.clear();
}
