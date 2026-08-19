"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { setFlash } from "@/lib/flash";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { lookupMarketValue } from "@/lib/parcel";

// Saves (or updates) what the owner paid, the year they bought, and what they
// still owe. purchase_price and mortgage_balance are new columns from
// migration 0029 that are not yet in src/lib/database.types.ts, so the update
// payload is cast to any (same pattern as the ai_usage route) rather than
// widening the generated types by hand. purchase_year is not a new column:
// it reuses properties.purchase_date, stored as YYYY-01-01 since only the
// year matters for the appreciation math.
//
// Returns { ok } so the client form only collapses on a save that actually
// stuck: a validation reject or soft-fail resolves the promise too, and
// closing on that would show stale values as if the save succeeded.
export async function saveHomeValueAction(
  formData: FormData
): Promise<ActionResult> {
  const property = await getActiveProperty();
  if (!property) throw new Error("No active property");

  const priceRaw = formData.get("purchase_price");
  const yearRaw = formData.get("purchase_year");
  const balanceRaw = formData.get("mortgage_balance");

  const purchasePrice = priceRaw ? Number(priceRaw) : null;
  const purchaseYear = yearRaw ? Number(yearRaw) : null;
  const mortgageBalance = balanceRaw ? Number(balanceRaw) : null;

  if (!purchasePrice || purchasePrice <= 0 || !purchaseYear) {
    return err(
      "Add what you paid and the year you bought your home to continue."
    );
  }

  // Server-side bounds (the form's min/max is client-only and can be
  // bypassed): a purchase year outside 1900..this year, or a wild price or
  // balance, would compound into an absurd "estimated value" shown in a big
  // confident font. Reject rather than clamp so the owner notices.
  const currentYear = new Date(Date.now()).getFullYear();
  if (
    !Number.isInteger(purchaseYear) ||
    purchaseYear < 1900 ||
    purchaseYear > currentYear ||
    !Number.isFinite(purchasePrice) ||
    purchasePrice > 100_000_000 ||
    (mortgageBalance != null &&
      (!Number.isFinite(mortgageBalance) ||
        mortgageBalance < 0 ||
        mortgageBalance > 100_000_000))
  ) {
    return err(
      "Those numbers don't look right. Double-check the year and amounts."
    );
  }

  const supabase = createClient();
  try {
    // RLS's existing "owner selects/updates own property" policy covers this,
    // same as updatePropertyAction in profile/actions.ts.
    const { error } = await (supabase.from("properties") as any)
      .update({
        purchase_price: purchasePrice,
        purchase_date: `${purchaseYear}-01-01`,
        mortgage_balance: mortgageBalance,
      })
      .eq("id", property.id);
    if (error) throw error;
    setFlash("Home value saved");
  } catch {
    // Migration 0029 may not have run yet against this database, or the
    // write failed for some other reason. Fail soft: the page keeps the form
    // open with an inline error instead of a 500.
    return err("Couldn't save right now. Please try again in a bit.");
  }
  revalidatePath("/value");
  revalidatePath("/dashboard");
  return ok();
}

// Lazily fetches and stores the RentCast AVM (estimated market value) for the
// active property, the first time someone actually opens /value, instead of
// billing every signup for a number most people never look at. Called by the
// ValueAutoFetch client component on mount; the property-record lookup in
// parcel.ts's lookupParcel is untouched.
//
// market_value/_low/_high are new columns from migration 0066 that are not
// yet in src/lib/database.types.ts, so the update payload is cast to any,
// same pattern as saveHomeValueAction above.
//
// Returns the fetched value (and its low/high range) alongside ok, so the
// caller (ValueAutoFetch) can show the number itself the instant this
// resolves instead of only learning it happened and having to wait on a
// router.refresh() round trip to see what it actually got.
export async function fetchAndSaveMarketValueAction(): Promise<{
  ok: boolean;
  marketValue?: number;
  marketValueLow?: number | null;
  marketValueHigh?: number | null;
}> {
  try {
    const property = await getActiveProperty();
    if (!property) return { ok: false };

    const raw = property as any;
    // Already have a value on file (from onboarding's own AVM call, an
    // earlier /value visit, or a re-billing-avoidance cache hit elsewhere):
    // no-op rather than re-fetching.
    if (typeof raw.market_value === "number") {
      return {
        ok: true,
        marketValue: raw.market_value,
        marketValueLow: raw.market_value_low ?? null,
        marketValueHigh: raw.market_value_high ?? null,
      };
    }

    // address_line1/zip are pre-existing typed columns, no cast needed.
    const street = property.address_line1 || null;
    const zip = property.zip || null;
    if (!street || !zip) return { ok: false };

    const facts = await lookupMarketValue(street, zip);
    if (facts.market_value == null) return { ok: false };

    const supabase = createClient();
    const { error } = await (supabase.from("properties") as any)
      .update({
        market_value: facts.market_value,
        market_value_low: facts.market_value_low,
        market_value_high: facts.market_value_high,
      })
      .eq("id", property.id);
    if (error) throw error;

    revalidatePath("/value");
    revalidatePath("/dashboard");
    return {
      ok: true,
      marketValue: facts.market_value,
      marketValueLow: facts.market_value_low ?? null,
      marketValueHigh: facts.market_value_high ?? null,
    };
  } catch (err) {
    // Fail soft: a lookup or write hiccup should never surface as a 500 on a
    // background fetch the owner didn't explicitly ask for.
    console.error("fetchAndSaveMarketValueAction failed:", err);
    return { ok: false };
  }
}
