import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
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

// Cached per request so calling it twice (e.g. layout) only queries once.
//
// No .eq("user_id", ...) filter here on purpose: once 0048_household_sharing
// has run, the "properties member select" RLS policy lets this same query
// also return homes shared with the caller, alongside the ones they own.
// Before that migration runs, the member select policy simply does not
// exist yet, so RLS still only returns owned rows, which is fine.
export const getProperties = cache(async (): Promise<PropertyWithShared[]> => {
  const user = await getUser();
  if (!user) return [];

  const supabase = createClient();
  const { data, error } = await supabase
    .from("properties")
    .select("*")
    .order("created_at", { ascending: true });

  // A failed query (network blip, Supabase outage) must NOT read as "this
  // user has no homes": that is what bounced onboarded users back to
  // /onboarding whenever wifi dropped. Throw instead, so the segment error
  // boundary renders its retry screen.
  if (error) {
    throw new Error(`Could not load your homes: ${error.message}`);
  }

  const rows = data;
  const withShared = rows.map((row) => ({
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

  const activeId = cookies().get(ACTIVE_HOME_COOKIE)?.value;
  return props.find((p) => p.id === activeId) ?? props[0];
}
