"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
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
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");

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

  const supabase = await createClient();
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

// WHERE THE PLUS LINE SITS ON HOME VALUE
//
// The FIRST estimate for a home is free, forever, and stays free: it is the
// hook, and taking it away would gate the moment someone first sees Hearth do
// something for them. That is fetchAndSaveMarketValueAction below, which only
// ever fires when there is no value on file (the auto-fetch on claim or first
// visit), and it has no membership check on purpose.
//
// REFRESHING an estimate that already exists is the Plus half, and it is the
// only path that can bill RentCast a second time for the same home.
// refreshMarketValueAction is the one such path, and it checks hasPlus() on
// the server before it spends anything. The UI shows the door before the tap
// (a "Plus" tag on the button, one line under the number), so a free account
// never discovers this by being refused.

// Shared abuse limits for anything here that can reach RentCast. Its own
// buckets, not the address-lookup ones onboarding spends: an AVM refresh must
// not be able to eat the budget a new home needs to get claimed. Same fixed
// window RPC and the same fail-open posture as every other rate_limit_hit call
// in this codebase - a limiter hiccup must not break a refresh - and both the
// automatic first fetch and the manual Plus refresh count against the same
// per-user budget, because they cost the same money.
async function avmBudgetAllows(userId: string): Promise<boolean> {
  const limiter = createAdminClient();
  const { data: allowedHour } = await limiter.rpc("rate_limit_hit", {
    p_bucket: `avm:${userId}`,
    p_limit: 10,
    p_window_seconds: 3600,
  });
  const { data: allowedDay } = await limiter.rpc("rate_limit_hit", {
    p_bucket: `avm-day:${userId}`,
    p_limit: 25,
    p_window_seconds: 86400,
  });
  return allowedHour !== false && allowedDay !== false;
}

// Lazily fetches and stores the RentCast AVM (estimated market value) for the
// active property, the first time someone actually opens /value, instead of
// billing every signup for a number most people never look at. Called by the
// ValueAutoFetch client component on mount; the property-record lookup in
// parcel.ts's lookupParcel is untouched.
//
// FREE FOR EVERYONE, deliberately: see the note above. It is a no-op once a
// value exists, so it can never be the second call for a home.
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

    // METERED, because this action can reach RentCast. The parcel_cache row
    // (30 days for a hit, 1 day for a miss) absorbs the normal case, but an
    // "unavailable" result is deliberately never cached (see lookupMarketValue
    // in src/lib/parcel.ts), so during an outage every call goes out to the
    // network - and this action is callable in a loop by anything holding a
    // session, not just by the component that normally fires it once.
    //
    // Its own buckets, not the parcel ones onboarding spends: see
    // avmBudgetAllows above.
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) return { ok: false };
    if (!(await avmBudgetAllows(user.id))) return { ok: false };

    // The unit rides along (migration 0127): an AVM run on the bare street
    // values the building, not this condo.
    const facts = await lookupMarketValue(street, zip, property.unit);
    if (facts.market_value == null) return { ok: false };

    const supabase = await createClient();
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

// PLUS ONLY. Re-runs the AVM for a home that already has a value on file and
// stores whatever comes back. This is the only code path in the app that can
// bill RentCast twice for the same address, which is exactly why it is the one
// with a membership check.
//
// The check is SERVER-SIDE and unconditional. The button a free account sees
// is already a link to /plus rather than a submit (see RefreshValue.tsx), so
// this refusal is a backstop for anyone calling the action directly, not the
// thing a homeowner is meant to run into. It still answers in plain words
// rather than throwing, because a bare 500 tells nobody anything.
//
// Cost shape, and why "monthly" is the honest word for this: lookupMarketValue
// keeps a real hit in parcel_cache for 30 days, so refreshing twice in a week
// re-reads the cached number and bills nothing. The estimate can genuinely
// move about once a month, which is what the copy promises.
export async function refreshMarketValueAction(): Promise<ActionResult> {
  const property = await getActiveProperty();
  // Ownership comes from getActiveProperty, which re-validates through RLS on
  // every read: no property id is ever accepted from the browser here.
  if (!property) return err("Add your home first.");

  if (!(await hasPlus())) {
    return err(
      "Refreshing your estimate is part of Hearth Plus. Your first estimate stays free."
    );
  }

  const street = property.address_line1 || null;
  const zip = property.zip || null;
  if (!street || !zip) {
    return err("Add your home's address to refresh the estimate.");
  }

  const {
    data: { user },
  } = await (await createClient()).auth.getUser();
  if (!user) return err("Sign in to refresh your estimate.");

  // OWNER ONLY, and checked BEFORE anything is spent.
  //
  // getActiveProperty also returns a home the caller is an active household
  // MEMBER of ("properties member select", 0051), and Plus carries across a
  // household, so a member passed hasPlus(), burned an avm: budget slot, billed
  // RentCast on a cache miss, and then wrote nothing at all - the only UPDATE
  // policy on properties is "properties owner update" (user_id = auth.uid(),
  // 0002), so RLS filtered the row out, PostgREST returned no error, and the
  // action reported success. Real money, no result, no complaint.
  //
  // Placed above avmBudgetAllows on purpose: a refusal must not spend the
  // rate-limit budget the owner's own refresh needs.
  if (property.user_id !== user.id) {
    return err("Only the home's owner can change this.");
  }

  if (!(await avmBudgetAllows(user.id))) {
    return err("You've refreshed a few times just now. Try again in a bit.");
  }

  try {
    const facts = await lookupMarketValue(street, zip, property.unit);
    if (facts.market_value == null) {
      // Keep the number that is already on file rather than blanking it: no
      // fresh reading is not the same as the home being worth nothing.
      return err(
        "No fresh estimate came back for your address. The one on file is still good."
      );
    }

    const supabase = await createClient();
    // .select("id"): an update that matches no row comes back as a success
    // with an empty result set, so the row count is the only way to tell a
    // real save from a write RLS quietly dropped. The owner check above should
    // make that impossible; this is the belt to its braces, and it is cheap.
    const { data: saved, error } = await (supabase.from("properties") as any)
      .update({
        market_value: facts.market_value,
        market_value_low: facts.market_value_low,
        market_value_high: facts.market_value_high,
      })
      .eq("id", property.id)
      .select("id");
    if (error) throw error;
    if (!saved || saved.length === 0) {
      console.error(
        "refreshMarketValueAction: update matched no rows for property",
        property.id
      );
      return err("Couldn't refresh right now. Please try again in a bit.");
    }

    revalidatePath("/value");
    revalidatePath("/dashboard");
    return ok();
  } catch (e) {
    console.error("refreshMarketValueAction failed:", e);
    return err("Couldn't refresh right now. Please try again in a bit.");
  }
}
