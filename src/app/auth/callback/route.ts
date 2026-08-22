import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNextPath } from "@/lib/safeNext";
import { requestOrigin } from "@/lib/requestOrigin";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";

// Handles the PKCE/OAuth code exchange: ?code=...
// (Magic-link flows use /auth/confirm instead.)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  // requestOrigin, not new URL(request.url).origin: the latter carries the
  // dev server's bind address (`-H 0.0.0.0`) and strands the browser there.
  const origin = requestOrigin(request);
  const code = searchParams.get("code");
  // ?next= is attacker-influenceable (e.g. via resetPasswordForEmail's
  // redirectTo), so only follow it when it's a same-origin relative path.
  const next = safeNextPath(searchParams.get("next")) ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // The other half of the email-confirmation terms gap: when Supabase
      // email confirmation is ON, signUp() (homeowner-signup/contractor-signup
      // page.tsx) returns no session, so their own recordTermsAcceptance()
      // call never fires - the confirmation link lands HERE instead, and this
      // is the first point a userId is available for that flow. Awaited
      // (not fire-and-forget) since this is a route handler: nothing is
      // guaranteed to keep running after the redirect response below is
      // returned.
      //
      // Gated to the confirmation flow specifically, not every code exchange
      // this route handles: password reset (resetPasswordForEmail's
      // redirectTo) also lands here, and that user did NOT just agree to
      // anything - terms_acceptances is a legal audit trail, so a row there
      // has to mean what it says. The two signup pages always build their
      // confirmation link's ?next= as /onboarding or /pro/onboarding (see
      // confirmRedirectUrl() in each), so that prefix is the signal this is
      // the signup-confirmation flow and not some other use of this route.
      // recordTermsAcceptance is idempotent (checks for an existing row
      // first), so a user already recorded via the signup page's own call -
      // or a confirmation link visited twice - does not get a duplicate row.
      const isSignupConfirmation =
        next === "/onboarding" ||
        next.startsWith("/onboarding?") ||
        next === "/pro/onboarding" ||
        next.startsWith("/pro/onboarding?");
      if (data.user && isSignupConfirmation) {
        let role = (data.user.user_metadata?.role ??
          data.user.app_metadata?.role) as string | undefined;

        // Google (GoogleSignInButton.tsx) signups arrive here with no role
        // at all: unlike the email/password signup pages, signInWithOAuth()
        // has no options.data to stamp role/full_name onto the new user at
        // creation time, so it has to be backfilled the first time we see
        // them with a session - which is here. `next` is reliable for this:
        // isSignupConfirmation already established it's /onboarding or
        // /pro/onboarding, and only contractor-signup's Google button ever
        // points at the latter, so next.startsWith("/pro") is exactly
        // "came from contractor-signup." An existing user signing IN via
        // Google keeps whatever role they already have - they don't reach
        // this branch at all unless `next` happens to be /onboarding or
        // /pro/onboarding (only the two signup pages' redirectTo sets that),
        // and even then `role` above is already set from their original
        // signup, so the `!role` check below leaves them untouched.
        const meta = data.user.user_metadata ?? {};
        const needsRole = !role;
        // Supabase maps Google's profile name into user_metadata.name (the
        // OIDC "name" claim). The current Supabase Auth (gotrue) Google
        // provider also copies that into a "to be deprecated" full_name
        // field, but that's an implementation detail of the current
        // version, not a documented guarantee, so mirror it ourselves.
        // Ownership verification (src/app/onboarding/actions.ts) reads
        // user_metadata.full_name to match the account holder's name
        // against the county assessor's owner-of-record, and it's the only
        // consumer of that field that matters pre-launch, so a missing
        // full_name here would silently break that check for Google
        // signups if gotrue's compat copy ever goes away.
        const needsFullName =
          !meta.full_name && typeof meta.name === "string" && meta.name;

        if (needsRole || needsFullName) {
          if (needsRole) {
            role = next.startsWith("/pro") ? "contractor" : "homeowner";
          }
          const admin = createAdminClient();
          const { error: updateError } = await admin.auth.admin.updateUserById(
            data.user.id,
            {
              user_metadata: {
                ...meta,
                ...(needsRole ? { role } : {}),
                ...(needsFullName ? { full_name: meta.name } : {}),
              },
            }
          );
          if (updateError) {
            // Best-effort, same as recordTermsAcceptance below: never block
            // the redirect on this. Worst case a Google signup lands without
            // a role (getRole() falls back to the contractor-row check,
            // then null, same as any pre-role-metadata legacy account) or
            // without full_name (ownership verification just stays
            // unverified, same as any other best-effort failure there).
            console.error("auth/callback: failed to backfill OAuth user_metadata", {
              userId: data.user.id,
              updateError,
            });
          } else if (needsRole) {
            // The role we just stamped lives in auth.users, but the session
            // cookie this request set (exchangeCodeForSession above) still
            // holds the pre-stamp JWT with no role. Cookie-based getRole()
            // (the /pro and /pro/onboarding guards read it, not the live auth
            // server) would therefore see null and bounce a brand-new Google
            // contractor through the role picker -> /pro -> /get-started ->
            // picker until the token expired. Refresh the session so the
            // cookie carries a JWT with role BEFORE we redirect them in.
            // Same cookie-write path exchangeCodeForSession already relies on,
            // so it propagates onto the redirect response the same way.
            const { error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError) {
              console.error(
                "auth/callback: failed to refresh session after role stamp",
                { userId: data.user.id, refreshError }
              );
            }
          }
        }

        await recordTermsAcceptance(
          data.user.id,
          role === "contractor" ? "pro_terms" : "terms"
        );
      }

      // The plain-sign-in (and any-other-entry) case for a brand-new Google
      // user. The block above only assigns a role when `next` is one of the
      // two signup pages' redirect targets, because there the door the user
      // walked through IS their role choice. A user arriving via the plain
      // /signin page instead has `next` = /dashboard (or some other gated
      // path), so isSignupConfirmation is false and no role was assigned -
      // yet they still have none. We must not guess one here: that would
      // half-initialize them on the wrong side of the app. Ask instead, by
      // sending them to the role picker. Existing users already carry a role,
      // so `!role` leaves them completely untouched and they follow `next`.
      if (data.user && !isSignupConfirmation) {
        const role = (data.user.user_metadata?.role ??
          data.user.app_metadata?.role) as string | undefined;
        if (!role) {
          // Same best-effort full_name backfill as the signup block above -
          // ownership verification (onboarding/actions.ts) reads
          // user_metadata.full_name and OAuth users arrive without it. No
          // terms acceptance is recorded on this path: /welcome/role records
          // it after the user actually picks a role.
          const meta = data.user.user_metadata ?? {};
          const needsFullName =
            !meta.full_name && typeof meta.name === "string" && meta.name;
          if (needsFullName) {
            const admin = createAdminClient();
            const { error: updateError } =
              await admin.auth.admin.updateUserById(data.user.id, {
                user_metadata: { ...meta, full_name: meta.name },
              });
            if (updateError) {
              console.error(
                "auth/callback: failed to backfill OAuth full_name",
                { userId: data.user.id, updateError }
              );
            }
          }
          return NextResponse.redirect(
            new URL(`/welcome/role?next=${encodeURIComponent(next)}`, origin)
          );
        }
      }
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=auth_failed`);
}
