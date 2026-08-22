import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/dbErrors";
import type { Contractor } from "@/lib/database.types";

// Every contractors column any caller of getCurrentContractor() actually
// reads, and nothing else. Traced from all ~60 call sites: the pro layout and
// dashboard, the profile/business/billing screens, the license verify and
// background check flows in pro/actions.ts, the AI routes (pro-ask,
// draft-apply, pro-tools, pro-compliance), and the OG card routes.
//
// Deliberately NOT selected, because nothing downstream of this helper reads
// them:
//   balance                 - the wallets table is the live source; pro/page
//                             and pro/business both query it directly
//   vetted                  - written once at signup (pro/actions.ts), a
//                             matchability flag no read path consults
//   checkr_candidate_id     - only the Checkr webhook reads it, from its own
//   background_check_detail   admin query, never through this helper
//   created_at              - the one contractor.created_at read is in the
//                             pro-winback cron, off its own query
//   license_insurance_updated_at - written, never read back
//
// That is not just bytes. src/app/pro/profile/page.tsx hands this whole row to
// ProfileTabs, which is a client component, so every column here is serialized
// into the browser's RSC payload on every /pro/profile load. Trimming keeps
// the pro's wallet balance and their raw background-check detail out of it.
const CONTRACTOR_COLUMNS = [
  "id",
  "user_id",
  "name",
  "license_number",
  "license_expires",
  "license_doc_path",
  "insurance_doc_path",
  "license_verified_status",
  "license_verified_at",
  "license_verify_detail",
  "background_check_status",
  "background_checked_at",
  "categories",
  "service_area",
  "serves_orange_county",
  "launch_cities",
  "contact_email",
  "contact_phone",
  "rating",
  "review_count",
  // Post-0033 columns that are absent from the generated Database type and so
  // are read everywhere as (contractor as any).x. They are real columns; the
  // types file simply has not been regenerated. Same reason the whole query
  // below goes through an `any` cast.
  "service_state",
  "license_state",
  "slug",
  "logo_url",
  "about",
  "yelp_url",
  "google_reviews_url",
  "insurance_carrier",
  "insurance_expires",
].join(", ");

// The current user's contractor company, or null if they aren't a pro.
// A user is treated as a contractor iff a contractors row links to their uid.
// Cached per request so repeated calls don't re-query.
export const getCurrentContractor = cache(
  async (): Promise<Contractor | null> => {
    // Deliberately NOT src/lib/auth.ts's getUser(): that helper trusts
    // getSession(), which reads the user id straight off the (unverified)
    // cookie. Below we hand that id to the admin client, which bypasses RLS
    // entirely, so a cookie-edited id would let an attacker read any
    // contractor's full row (balance, checkr_*, license_verify_detail, ...).
    // supabase.auth.getUser() here re-checks the id against Supabase's auth
    // server, so it's safe to trust before the admin-client query below.
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) return null;

    // Admin client, not the user client: 0067 stripped column-level SELECT on
    // contractors down to the public columns, so a user-client `select *`
    // would error on the sensitive columns (balance, checkr_*, *_doc_path,
    // license_verify_detail, ...). The session is already validated via
    // supabase.auth.getUser() above and the query is pinned to
    // `.eq("user_id", user.id)`, so the admin client still returns only the
    // caller's own row.
    const supabase = createAdminClient();
    // The `any` cast is unavoidable: CONTRACTOR_COLUMNS names real columns
    // (migrations 0033/0043/0046/0051) that src/lib/database.types.ts has not
    // been regenerated for, and the typed client rejects a select string
    // mentioning a column it does not know about. Same convention the app
    // already uses for these fields at every read site. The result is asserted
    // back to Contractor because the projection also drops keys the generated
    // Row type marks required; every property any caller reads is present.
    const { data, error } = await (supabase.from("contractors") as any)
      .select(CONTRACTOR_COLUMNS)
      .eq("user_id", user.id)
      .maybeSingle();

    // An explicit column list is not resilient the way select("*") was: on a
    // database that has not run one of the migrations above, Postgres rejects
    // the WHOLE query with 42703 rather than quietly omitting the column. That
    // would make this helper return null, which reads as "not a pro" and
    // bounces every contractor to /pro/onboarding. So a missing-column failure
    // falls back to the old wide select instead, exactly as before. Any other
    // error keeps the previous behavior too (null, no throw).
    if (error) {
      if (!isMissingSchemaError(error)) return null;
      const { data: wide } = await supabase
        .from("contractors")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      return wide ?? null;
    }

    return (data as Contractor | null) ?? null;
  }
);

// Cheap role check - reuses the cached contractor lookup.
export async function isContractor(): Promise<boolean> {
  return (await getCurrentContractor()) !== null;
}

export type Role = "homeowner" | "contractor";

// The current user's role, used to route a single sign-in to the right side of
// the app. Set explicitly at sign-up (user_metadata.role); for legacy accounts
// created before that, we fall back to inferring it from a contractor company.
// A user with neither signal has NO known role and gets null: callers that
// only branch on "contractor"/"homeowner" behave as before (null falls into
// the homeowner-side default), but /pro can now send them to the role chooser
// instead of silently trapping them in the homeowner flow.
export const getRole = cache(async (): Promise<Role | null> => {
  const user = await getUser();
  if (!user) return null;

  const meta = (user.user_metadata?.role ?? user.app_metadata?.role) as
    | string
    | undefined;
  if (meta === "contractor" || meta === "homeowner") return meta;

  // Legacy fallback: a company row means they're a contractor.
  return (await isContractor()) ? "contractor" : null;
});

// How many PAID lead applications this contractor has: lead_applications rows
// they own whose fee was not refunded (a ghost-protection refund means the
// lead never really cost them anything, so it does not count toward an
// earn-in). Used by the Hearth-funded background check gate, which spends real
// money per check and therefore only opens after
// BACKGROUND_CHECK_MIN_PAID_LEADS of them.
//
// Returns null when the count could NOT be read. Callers must treat null as
// "not enough": this decides whether Hearth pays a third-party bill, so a
// broken read has to fail closed rather than hand out a free check on the
// strength of an outage. Cached per request so the page and the action that
// both need it share one query.
export const countPaidLeadApplications = cache(
  async (contractorId: string): Promise<number | null> => {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("lead_applications")
      .select("id", { count: "exact", head: true })
      .eq("contractor_id", contractorId)
      .is("refunded_at", null);
    if (error) {
      console.error(
        "countPaidLeadApplications failed:",
        error.message ?? error
      );
      return null;
    }
    return count ?? 0;
  }
);
