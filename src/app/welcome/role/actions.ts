"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSides, landingFor } from "@/lib/contractor";
import { setFlash } from "@/lib/flash";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import { safeNextPath } from "@/lib/safeNext";

// Commits the role choice made on /welcome/role, for anyone who has not built
// a side yet: the brand-new OAuth user who arrived with no stamp at all (see
// src/app/auth/callback/route.ts for how they get here), and the person who
// carries a stamp but nothing else and wants to change their mind. Mirrors the
// two signup pages' post-choice behavior: stamp the role into user_metadata,
// record the matching terms acceptance, and drop them into the right
// onboarding flow.
export async function chooseRoleAction(formData: FormData) {
  // Re-auth server-side rather than trusting anything the form carried: this
  // is a "use server" action reachable by a crafted POST, so the caller's
  // identity has to come from a verified session, not the request body.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Idempotency + safety guard, and the security-relevant line: this picker
  // must never flip an ESTABLISHED account from one side to the other, whether
  // from a double submit, a bookmarked URL, or a forged request.
  //
  // What makes an account established is a ROW - a contractors row, or a home
  // - not the stamp. The guard used to key on the stamp alone, and that made
  // the choice unrepeatable for someone who had made no progress on it: a
  // contractor-signup account whose company save keeps failing owns nothing
  // but the word "contractor" in its metadata, and this action answered a
  // request to become a homeowner by redirecting to /pro, which redirects to
  // the company wizard it is trying to leave. With neither row there is
  // nothing built to protect and nothing to take away, so the choice is theirs
  // to make again; the moment either row exists, this returns to being a dead
  // end. Anything to do with a side an account genuinely holds still belongs
  // to setPreferredSideAction (src/lib/sideActions.ts).
  const sides = await getSides();
  if (sides.hasPro || sides.hasHome) redirect(landingFor(sides));

  // The guard above is a ROW check, and a row check that could not run is not
  // the same as a row that is not there. If the contractors (or properties)
  // lookup errored, getSides() reports hasPro/hasHome false for a reason that
  // has nothing to do with this account - and this action would then happily
  // re-stamp someone who does own a side, which is exactly what the guard
  // exists to prevent.
  //
  // Refused on ANY failed check, stamp or no stamp. The old version only
  // refused when a role stamp was already on file, on the theory that a
  // stampless account has built nothing worth protecting - but "no stamp" is
  // read off user metadata, not off the rows that failed to load, so it says
  // nothing about whether a contractors row or a property exists. An OAuth
  // account can hold either without ever having been stamped (the callback
  // backfills the stamp separately), and letting a failed read through would
  // hand that account a role it has to fight its way back out of. Making a
  // brand-new user retry after a transient DB hiccup is the cheaper mistake.
  if (sides.checked === false) {
    await setFlash(
      "We couldn't check your account just now. Try again in a minute.",
      "error"
    );
    redirect("/welcome/role");
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
