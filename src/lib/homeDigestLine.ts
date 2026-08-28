import { headlineHomeValue, calculateEquity } from "@/lib/homeValue";
import { plausibleHomeFigure } from "@/lib/parcelSanity";

// The monthly home digest's one line about money: "Your home's estimated
// value is $X[, about $Y of it equity]." Pulled out of
// src/app/api/cron/home-digest/route.ts into its own module because a route
// file may only export its HTTP handlers and a small set of Next.js config
// names (runtime, dynamic, revalidate, etc.) - Next's route-module type
// rejects any other export, which broke the production build when this was
// exported straight from route.ts. Pure and exported here so a test can
// cover the building-record gate below without importing the route (and
// therefore without needing to mock the admin Supabase client or notify).

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export interface HomeValueEquityLineInput {
  purchasePrice: number | null;
  purchaseYear: number | null;
  mortgageBalance: number | null;
  marketValue: number | null;
  marketValueLow: number | null;
  marketValueHigh: number | null;
  unit: string | null | undefined;
  propertyType: string | null | undefined;
  sqft: number | null;
  state: string | null | undefined;
  currentYear: number;
}

// THE BUILDING-RECORD GATE (src/lib/parcelSanity.ts). A condo or
// multi-family county record covers the whole building, so a stored purchase
// price can be the building's, not the unit's - the same $34,000,000
// purchase price a tester was shown on /value for a $799,000 condo. Gating
// it here means an implausible price never reaches headlineHomeValue and
// never turns into an inflated "estimated value" line in a monthly email.
// market_value (the AVM) is the estimate the gate measures against, never
// the purchase price itself, same as /value and /taxes.
//
// Preserves the pre-existing behavior that this line only appears when BOTH
// a purchase price and a purchase year are on file, even if an AVM value
// exists on its own: this helper only decides whether the line is honest,
// not whether the digest should try to show one.
export function homeValueEquityLine(
  input: HomeValueEquityLineInput
): string | null {
  const {
    purchasePrice: storedPurchasePrice,
    purchaseYear,
    mortgageBalance,
    marketValue,
    marketValueLow,
    marketValueHigh,
    unit,
    propertyType,
    sqft,
    state,
    currentYear,
  } = input;

  if (!storedPurchasePrice || !purchaseYear) return null;

  const purchasePrice = plausibleHomeFigure(storedPurchasePrice, {
    unit,
    propertyType,
    sqft,
    estimate: marketValue,
  });
  if (purchasePrice == null) return null;

  // Non-null by construction: purchasePrice and purchaseYear are both
  // confirmed above, which is the fallback's only requirement.
  const value = headlineHomeValue({
    marketValue,
    marketValueLow,
    marketValueHigh,
    purchasePrice,
    purchaseYear,
    state,
    currentYear,
  })!.value;
  const equity = calculateEquity(value, mortgageBalance);
  return mortgageBalance !== null && equity > 0
    ? `Your home's estimated value is ${usd(value)}, about ${usd(equity)} of it equity.`
    : `Your home's estimated value is ${usd(value)}.`;
}
