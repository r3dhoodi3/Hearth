"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import { safeNextPath } from "@/lib/safeNext";

// Commits the role choice made on /welcome/role for a brand-new OAuth user who
// arrived with none (see src/app/auth/callback/route.ts for how they get here).
// Mirrors the two signup pages' post-choice behavior: stamp the role into
// user_metadata, record the matching terms acceptance, and drop them into the
// right onboarding flow.
export async function chooseRoleAction(formData: FormData) {
  // Re-auth server-side rather than trusting anything the form carried: this
  // is a "use server" action reachable by a crafted POST, so the caller's
  // identity has to come from a verified session, not the request body.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Idempotency + safety guard: if this user already has a role, never touch
  // it - just send them home. This is the security-relevant line. The picker
  // exists only to give a role-less user one; it must never be able to flip
  // an established homeowner into a contractor (or vice versa), whether from a
  // double submit, a bookmarked URL, or a forged request.
  const existingRole = (user.user_metadata?.role ??
    user.app_metadata?.role) as string | undefined;
  if (existingRole === "contractor" || existingRole === "homeowner") {
    redirect(existingRole === "contractor" ? "/pro" : "/dashboard");
  }

  // Only the two real roles are accepted; anything else is a malformed or
  // forged submit and gets bounced back to the picker.
  const submitted = formData.get("role");
  if (submitted !== "homeowner" && submitted !== "contractor") {
    redirect("/welcome/role");
  }
  const role = submitted;

  // A form field is still attacker-influenced input, so re-validate the
  // carried destination with the same guard used everywhere else ?next= is
  // read.
  const next = safeNextPath(formData.get("next") as string | null);
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";

  // Merge, don't replace: read the current metadata and spread it so existing
  // keys (full_name, backfilled in the callback) survive - the same merge the
  // auth/callback route does when it stamps a role.
  const meta = user.user_metadata ?? {};
  const admin = createAdminClient();
  const { error: updateError } = await admin.auth.admin.updateUserById(
    user.id,
    { user_metadata: { ...meta, role } }
  );
  if (updateError) {
    // Unlike the best-effort backfills elsewhere, the role is the whole point
    // of this action, so a failure here can't silently redirect as if it
    // worked - surface it so the user can retry rather than landing role-less
    // again.
    throw new Error("Could not save your choice. Please try again.");
  }

  // The role now lives in auth.users, but the current session cookie still
  // holds the pre-stamp JWT with no role. Cookie-based getRole() (the /pro,
  // /pro/onboarding and /onboarding guards read the cookie, not the live auth
  // server) would see null and bounce this user straight back through the
  // picker -> /pro -> /get-started -> picker loop. Refresh so the cookie
  // carries a JWT with role before we redirect them into onboarding.
  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) {
    console.error(
      "chooseRoleAction: failed to refresh session after role stamp",
      refreshError
    );
  }

  // Best-effort audit-trail write, same void pattern the signup pages use.
  if (role === "contractor") {
    void recordTermsAcceptance(user.id, "pro_terms");
    // Contractor onboarding redirects on its own (saveCompanyAction), so a
    // carried ?next= wouldn't survive past it - matches contractor-signup,
    // which likewise doesn't thread next into /pro/onboarding here.
    redirect("/pro/onboarding");
  }

  void recordTermsAcceptance(user.id, "terms");
  // Homeowner: route through onboarding first (the claimed-home gate), keeping
  // the original destination as ?next= exactly the way homeowner-signup does.
  redirect(`/onboarding${nextQuery}`);
}
