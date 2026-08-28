import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { formatAddressLine } from "@/lib/addressLine";
import type { Property } from "@/lib/database.types";

// Which home the owner is currently viewing. A user can have several; this
// cookie picks the active one. Ownership is re-validated on every read, so a
// stale/forged value just falls back to their first home.
export const ACTIVE_HOME_COOKIE = "hearth_active_home";

// A property row plus whether it belongs to the signed-in user or was shared
// with them as a household member.
export type PropertyWithShared = Property & { isShared: boolean };

// The only fields the client-side home switcher needs. Projecting to this
// before handing homes to a "use client" component keeps the sensitive
// properties columns (mortgage_balance, purchase_price, assessed_value,
// insurance_premium, ownership_owner_names, parcel_id, purchase_date, and the
// owner's user_id) out of the RSC payload the browser receives on every app
// page.
export type HomeSummary = Pick<
  PropertyWithShared,
  "id" | "address_line1" | "isShared"
>;

// The address as a human should read it - "123 Main St, Unit 4B". Implemented
// in @/lib/addressLine (pure, no server imports, so the onboarding form can
// use it too) and re-exported here, which is where every server caller already
// looks for property helpers.
export { formatAddressLine, type AddressLineParts } from "@/lib/addressLine";

// The home rows the nav's switcher labels itself from, with address_line1
// swapped for the display line (street + unit). Called by the app layout,
// which is where the switcher's homes come from, so the switcher and the
// header components underneath it stay exactly as they were: a condo owner
// with two units in one building would otherwise see the same label twice with
// no way to tell which home is which.
//
// The swap is confined to this projection ON PURPOSE. These rows only ever
// reach the switcher's label, never a lookup: everything that queries by
// address - the RentCast call, the parcel cache key, the assessor ownership
// match - reads the real address_line1 off the row from getProperties.
export function homesForSwitcher(
  homes: PropertyWithShared[]
): PropertyWithShared[] {
  return homes.map((home) =>
    home.unit ? { ...home, address_line1: formatAddressLine(home) } : home
  );
}

// Every properties column some caller of getProperties()/getActiveProperty()
// actually reads, and nothing else. Traced across the dashboard, forecast,
// value, taxes, documents and home-report pages, the ask/tax-appeal/
// insurance-packet/home-alerts API routes, contractors/actions.ts, Nav, and
// this file's own sort.
//
// Worth being precise about the sensitive list in the HomeSummary comment
// above, because it overstates what is droppable: mortgage_balance,
// purchase_price, assessed_value, insurance_premium, purchase_date and
// user_id are all genuinely read on the server (the value, taxes, documents
// and dashboard pages, and the isShared / household-Plus lookups), so they
// have to stay in the row. What that comment is really protecting is the RSC
// payload, and HomeSummary still does that job. What CAN go, because nothing
// anywhere reads it back, is the write-only assessor bookkeeping:
//   parcel_id, ownership_owner_names, ownership_owner_type,
//   ownership_owner_occupied  - written by record_ownership_check / onboarding
//   ownership_verified        - self-attested MVP flag, superseded by
//                               ownership_status and marked dead in
//                               src/app/onboarding/actions.ts
//   property_type              - written at onboarding, never read off a
//                               property row (the onboarding form reads it
//                               off the parcel lookup, not the DB row)
// lot_size_sqft used to be in that same "write-only" group, but the
// home-details editor (src/app/(app)/home-details/page.tsx) now prefills its
// form from this row, so it has to stay in the select below.
// ownership_owner_names in particular is an unbounded json blob carried on
// every home on every app page.
// Whether this process has already learned that properties.unit (migration
// 0127) does not exist on the live database.
//
// The column name alone makes Postgres reject the WHOLE select with 42703, and
// the fallback below catches that and retries with select("*"). Correct, but
// paid on EVERY request until someone runs the migration: a failed query plus
// a retry, forever, for a column the database has already told us it does not
// have. Remembering the answer turns that into one failed query per process.
//
// A TTL, not a permanent flag. The answer is only ever set one way, toward
// "missing", and it is only ever learned from a real failed query, so it can
// never be set optimistically. But it goes STALE in one direction that
// matters: the moment 0127 is applied, every process that has already learned
// "missing" keeps dropping `unit` from its projection until it restarts. On a
// long-lived server that is indefinitely, and the symptom is silent - a condo
// owner's address renders without their unit number and nothing errors, so
// nobody reports it. Ten minutes is short enough that applying the migration
// heals itself without a deploy, and long enough that the failed-query-plus-
// retry it exists to avoid is paid at most six times an hour per process.
//
// A stale "missing" costs nothing but the unit line (formatAddressLine treats
// a dropped column exactly like a null unit); a stale "present" costs one
// failed query and one retry, which is the behaviour this cache replaced. Both
// directions are safe, which is why an expiry is affordable here at all.
//
// claimPropertyAction (src/app/onboarding/actions.ts) sets it too, from the
// other direction: its insert is usually the first thing in a process to find
// out.
const UNIT_MISSING_TTL_MS = 10 * 60 * 1000;
let unitMissingUntil = 0;

// Called by claimPropertyAction after an insert that failed WITH `unit` and
// succeeded WITHOUT it - which is proof, not a guess.
export function noteUnitColumnMissing(): void {
  unitMissingUntil = Date.now() + UNIT_MISSING_TTL_MS;
}

export function isUnitColumnMissing(): boolean {
  return Date.now() < unitMissingUntil;
}

// Every properties column some caller actually reads. Kept as a list rather
// than a string so `unit` can be dropped from it (see unitColumnMissing above)
// without re-deriving the rest.
const PROPERTY_COLUMN_NAMES = [
  "id",
  "user_id",
  "address_line1",
  // Migration 0127. Dropped from the select once this process has learned the
  // live DB does not have it yet; re-included as soon as a process starts
  // after 0127 is applied.
  "unit",
  "city",
  "state",
  "zip",
  "year_built",
  "sqft",
  "beds",
  "baths",
  "lot_size_sqft",
  "purchase_date",
  "ownership_status",
  "ownership_checked_at",
  // Required by this file itself: the .order() above and the created_at
  // tiebreak in the owned-then-shared sort below.
  "created_at",
  // Post-0029 money/valuation columns, absent from the generated Database type
  // and read everywhere as (property as any).x. Real columns; the types file
  // simply has not been regenerated.
  "purchase_price",
  "mortgage_balance",
  "market_value",
  "market_value_low",
  "market_value_high",
  "assessed_value",
  "assessed_year",
  "insurance_premium",
  "insurance_renewal_date",
];

function propertyColumns(): string {
  return (
    isUnitColumnMissing()
      ? PROPERTY_COLUMN_NAMES.filter((c) => c !== "unit")
      : PROPERTY_COLUMN_NAMES
  ).join(", ");
}

// Cached per request so calling it twice (e.g. layout) only queries once.
//
// No .eq("user_id", ...) filter here on purpose: once 0048_household_sharing
// has run, the "properties member select" RLS policy lets this same query
// also return homes shared with the caller, alongside the ones they own.
// Before that migration runs, the member select policy simply does not
// exist yet, so RLS still only returns owned rows, which is fine.
export const getProperties = cache(async (): Promise<PropertyWithShared[]> => {
  const user = await getUser();
  // No parseable session here means SIGN IN, never "this user has no homes".
  // Returning [] made every caller's `if (!property) redirect("/onboarding")`
  // misroute a signed-in user with a stale/unreadable cookie to onboarding,
  // where going back bounced them through /signin until the browser client
  // refreshed the token - the "random onboarding page" loop. Middleware
  // normally guarantees a session on these routes; the only way to get here
  // without one is that stale-cookie edge, and /signin (which restores the
  // session and returns them) is the honest answer for it.
  if (!user) redirect("/signin");

  const supabase = await createClient();
  // The `any` cast is unavoidable: propertyColumns() names real columns
  // (migrations 0029/0032/0039/0040/0043/0066) that src/lib/database.types.ts
  // has not been regenerated for, and the typed client rejects a select string
  // mentioning a column it does not know about. This is the same convention
  // the app already uses at every read site for these fields.
  const { data, error } = await (supabase.from("properties") as any)
    .select(propertyColumns())
    .order("created_at", { ascending: true });

  // A failed query (network blip, Supabase outage) must NOT read as "this
  // user has no homes": that is what bounced onboarded users back to
  // /onboarding whenever wifi dropped. Throw instead, so the segment error
  // boundary renders its retry screen.
  //
  // One exception, new with the explicit column list above: select("*") could
  // never fail over schema drift, but a named column that a database has not
  // migrated yet makes Postgres reject the WHOLE query with 42703. Throwing
  // there would turn a missing migration into "every app page is an error
  // screen", so that one shape retries with the old wide select instead.
  let rows = data as Property[] | null;
  if (error) {
    if (!isMissingSchemaError(error)) {
      throw new Error(`Could not load your homes: ${error.message}`);
    }
    // Remember it, so the next request in this process selects a column list
    // the database can actually answer instead of repeating this failure.
    // Only when the error names `unit`: any OTHER missing column (a live DB
    // behind on some future migration) has nothing to do with 0127, and
    // dropping `unit` on its account would be a guess.
    if (/\bunit\b/i.test(error.message ?? "")) {
      noteUnitColumnMissing();
    }
    const { data: wide, error: wideError } = await supabase
      .from("properties")
      .select("*")
      .order("created_at", { ascending: true });
    if (wideError) {
      throw new Error(`Could not load your homes: ${wideError.message}`);
    }
    rows = wide;
  }

  const withShared = (rows ?? []).map((row) => ({
    ...row,
    isShared: row.user_id !== user.id,
  }));

  // Owned homes first, then shared homes, each group ordered by created_at.
  withShared.sort((a, b) => {
    if (a.isShared !== b.isShared) return a.isShared ? 1 : -1;
    return a.created_at.localeCompare(b.created_at);
  });

  return withShared;
});

export async function getActiveProperty(): Promise<Property | null> {
  const props = await getProperties();
  if (props.length === 0) return null;

  const activeId = (await cookies()).get(ACTIVE_HOME_COOKIE)?.value;
  return props.find((p) => p.id === activeId) ?? props[0];
}
