import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getUser, getVerifiedUser } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/dbErrors";
import type { Contractor } from "@/lib/database.types";
import type { AuthRoleDecision, Role, Sides } from "@/lib/roleRouting";
import { preferredRole as narrowPreferredRole } from "@/lib/roleRouting";

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

// The contractors lookup, plus whether it actually ran.
//
// `checked` is false ONLY when the query could not be completed - a DB outage,
// a permissions failure, a connection reset. It is true for a clean "no such
// row", which is a real answer.
//
// The distinction exists because almost every caller may safely conflate the
// two ("no evidence they're a pro" is the safe default for opening a side),
// but one caller may not: chooseRoleAction (src/app/welcome/role/actions.ts)
// REFUSES to re-run the role choice for an established account, and decides
// that from the absence of a row. A failed read that looks like "no rows"
// there is a fail-OPEN: it would let the picker re-stamp an account whose
// contractors row it simply could not see.
export type ContractorLookup = {
  contractor: Contractor | null;
  checked: boolean;
};

// The current user's contractor company, or null if they aren't a pro.
// A user is treated as a contractor iff a contractors row links to their uid.
// Cached per request so repeated calls don't re-query.
export const getContractorLookup = cache(
  async (): Promise<ContractorLookup> => {
    // Deliberately NOT src/lib/auth.ts's getUser(): that helper trusts
    // getSession(), which reads the user id straight off the (unverified)
    // cookie. Below we hand that id to the admin client, which bypasses RLS
    // entirely, so a cookie-edited id would let an attacker read any
    // contractor's full row (balance, checkr_*, license_verify_detail, ...).
    // getVerifiedUser() re-checks the id against Supabase's auth server - the
    // exact same supabase.auth.getUser() network call this used to make
    // inline - so it is still safe to trust before the admin-client query
    // below. NOTHING about the trust boundary changes here: no header, no
    // cookie claim, no caller-supplied id is believed.
    //
    // What DOES change is how many times that call is made. This helper runs
    // in the layout of every signed-in page on both sides of the app, and
    // several pages inside those layouts re-verify for their own reasons
    // (/account/security, /account/household, /contractors, /inspection,
    // /quote-check, getPasswordStatus). The supabase client has no request
    // cache, so each inline supabase.auth.getUser() was its own sequential
    // round trip to Supabase's auth server. getVerifiedUser() is
    // React-cache()-wrapped, so every one of those call sites now shares ONE
    // verification per request instead of paying its own.
    // No signed-in user is a settled answer, not a failed read.
    const user = await getVerifiedUser();
    if (!user) return { contractor: null, checked: true };

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
      // Anything that is NOT the missing-column fingerprint is a read we could
      // not complete: null, as before, but flagged so the one caller that
      // refuses on "no row" can tell the difference.
      if (!isMissingSchemaError(error)) {
        console.error("getCurrentContractor lookup failed:", error.message ?? error);
        return { contractor: null, checked: false };
      }
      const { data: wide, error: wideError } = await supabase
        .from("contractors")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (wideError) {
        console.error(
          "getCurrentContractor wide fallback failed:",
          wideError.message ?? wideError
        );
        return { contractor: null, checked: false };
      }
      return { contractor: wide ?? null, checked: true };
    }

    return { contractor: (data as Contractor | null) ?? null, checked: true };
  }
);

// The row itself, for the ~60 call sites that only ever ask "is there a
// company, and what is in it". Shares getContractorLookup()'s per-request
// cache, so nothing pays an extra query for the narrower answer.
export const getCurrentContractor = cache(
  async (): Promise<Contractor | null> =>
    (await getContractorLookup()).contractor
);

// Cheap role check - reuses the cached contractor lookup.
export async function isContractor(): Promise<boolean> {
  return (await getCurrentContractor()) !== null;
}

// Defined in ./roleRouting so the pure routing rules can be imported (and
// unit tested) without dragging in the admin client's "server-only" guard.
// Re-exported here because every existing caller imports Role from this module.
export type { AuthRoleDecision, Role, Sides };
export {
  isProPath,
  isHomeownerShellPath,
  isSignupConfirmationPath,
  isFirstHomeSetupPath,
  destinationForSignIn,
  resolveAuthRole,
  landingFor,
  preferredRole,
  ROLE_PICKER_PATH,
} from "@/lib/roleRouting";

// The current user's PREFERRED side of the app - the one they land on when no
// destination was asked for. It is not a permission and no layout gates on it:
// an account can hold both sides at once (see getSides), and access to either
// follows the rows that exist, never this stamp. Prefer getSides() +
// landingFor() for any "where does this person go" decision; getRole() remains
// for the few places that only need the stamp itself.
//
// Set explicitly at sign-up (user_metadata.role); for legacy accounts created
// before that, we fall back to inferring it from a contractor company.
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

// The Sides type this returns lives in ./roleRouting (re-exported above), so
// landingFor() can be unit tested without dragging in the admin client.
//
// Homes visible to the signed-in user - owned OR shared with them as a
// household member, which is exactly what getProperties() returns and what
// getActiveProperty() picks from, so "has a home side" means the same thing
// here as it does to the (app) shell. A head count, not the rows: this is only
// ever asked as a yes/no.
//
// A read failure reads as "no home". Same posture as getCurrentContractor():
// the cost of being wrong is one misrouted request that self-corrects, and
// every caller only ever OPENS a side on the strength of a row. `checked`
// carries the same distinction ContractorLookup does, for the one caller that
// refuses on the absence of a row rather than opening on its presence.
async function hasHomeSide(): Promise<{ hasHome: boolean; checked: boolean }> {
  const supabase = await createClient();
  // No .eq("user_id", ...): the "properties member select" policy (0048) is
  // what makes a shared home visible, and filtering by owner would hide it.
  const { count, error } = await supabase
    .from("properties")
    .select("id", { count: "exact", head: true });
  if (error) {
    console.error("hasHomeSide failed:", error.message ?? error);
    return { hasHome: false, checked: false };
  }
  return { hasHome: (count ?? 0) > 0, checked: true };
}

// Both sides of the current account plus the side they prefer to land on.
// Cached per request; the contractor half reuses getCurrentContractor()'s own
// cache, so asking for sides in a layout that already loaded the company row
// costs one extra count query and nothing else.
export const getSides = cache(async (): Promise<Sides> => {
  const user = await getUser();
  if (!user) {
    return { hasPro: false, hasHome: false, preferred: null, checked: true };
  }

  const preferred = narrowPreferredRole(
    user.user_metadata?.role ?? user.app_metadata?.role
  );

  const [pro, home] = await Promise.all([
    getContractorLookup(),
    hasHomeSide(),
  ]);
  return {
    hasPro: pro.contractor !== null,
    hasHome: home.hasHome,
    preferred,
    // Both halves had to actually run for a false/false answer to mean "this
    // account has built nothing". See Sides.checked in ./roleRouting.
    checked: pro.checked && home.checked,
  };
});

// Does a contractors row link to this auth user? Admin client, keyed on the
// caller-supplied id, so it works in /auth/callback where the session cookie
// for the just-exchanged code isn't readable back yet. Only the existence of
// the row is returned, never its contents.
//
// A read failure returns false (i.e. "no evidence they're a pro"), matching
// getCurrentContractor()'s behavior on error. The cost of being wrong is one
// more pass through the same repair on their next request, not a wrong stamp:
// callers only ever UPGRADE a role on the strength of a row.
export async function contractorRowExists(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contractors")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("contractorRowExists failed", { userId, error });
    return false;
  }
  return data != null;
}

// Does a properties row belong to this auth user? The homeowner-side twin of
// contractorRowExists, and used in the same place for the same reason: in
// /auth/callback the session cookie for the just-exchanged code isn't readable
// back yet, so the id has to be passed in and the query has to bypass RLS.
//
// Owned homes only (.eq("user_id")), not homes shared with them: this answers
// "did this account build a homeowner side", and the callback only asks it to
// tell a dual-side account apart from a pro who wandered through the homeowner
// door. A read failure returns false, same as contractorRowExists.
export async function propertyRowExists(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("properties")
    .select("id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("propertyRowExists failed", { userId, error });
    return false;
  }
  return data != null;
}

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
