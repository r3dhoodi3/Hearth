import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNextPath } from "@/lib/safeNext";
import { requestOrigin } from "@/lib/requestOrigin";
import {
  PW_RECOVERY_COOKIE,
  passwordRecoveryCookieOptions,
} from "@/lib/passwordRecovery";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import {
  contractorRowExists,
  isFirstHomeSetupPath,
  propertyRowExists,
  resolveAuthRole,
} from "@/lib/contractor";

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

  // Is this the password-recovery flow? ONE signal only: ?type=recovery, the
  // parameter Supabase stamps on the link it emails.
  //
  // A draft also accepted "next points at /reset-password", on the reasoning
  // that ResetPasswordForm always builds redirectTo that way. That was wrong.
  // ?next= is caller-supplied on EVERY route through here - a Google sign-in
  // started from anywhere can carry next=/reset-password?step=update - so the
  // cookie would have been mintable by completing an ordinary sign-in with a
  // chosen query string, which is precisely the walk-up it exists to stop.
  // safeNextPath only proves the value is a relative path of ours; it says
  // nothing about who chose it.
  //
  // This decides ONE thing: whether to hand back the short-lived
  // hearth_pwrecovery cookie that /reset-password requires before it will
  // render the "set a new password" form. It grants nothing else, and a forged
  // ?type=recovery on a link with no valid code never reaches the set, because
  // everything below is inside `if (code)` and the exchange has to succeed.
  //
  // OPERATOR NOTE (docs/SECURITY-OPS.md): this depends on the reset link
  // carrying type=recovery all the way to this route. If password reset ever
  // stops advancing past step one, that is the thing to check first - the
  // supported fix is to point the "Reset Password" email template at
  // /auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=... , which
  // carries the parameter by construction.
  const isRecovery = searchParams.get("type") === "recovery";

  // Attach the cookie to whichever redirect this route ends up returning.
  const withRecoveryCookie = (response: NextResponse): NextResponse => {
    if (isRecovery) {
      response.cookies.set(
        PW_RECOVERY_COOKIE,
        "1",
        passwordRecoveryCookieOptions()
      );
    }
    return response;
  };

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
      // has to mean what it says. That gate now lives in resolveAuthRole's
      // termsDoc (src/lib/contractor.ts), keyed on the same signal: the two
      // signup pages always build their confirmation link's ?next= as
      // /onboarding or /pro/onboarding (see confirmRedirectUrl() in each).
      // recordTermsAcceptance is idempotent (checks for an existing row
      // first), so a user already recorded via the signup page's own call -
      // or a confirmation link visited twice - does not get a duplicate row.
      if (data.user) {
        const meta = data.user.user_metadata ?? {};
        const metadataRole = (meta.role ?? data.user.app_metadata?.role) as
          | string
          | undefined;

        // The contractors row, not `next`, is what makes someone a pro.
        // Google (GoogleSignInButton.tsx) sign-ins arrive with no options.data
        // to stamp anything at creation time, so a pro who signs in through
        // the HOMEOWNER door lands here carrying next=/onboarding and, if
        // their metadata role is missing or wrong, used to be stamped
        // "homeowner" on the strength of that door alone - which sent them
        // around /onboarding -> /pro -> /dashboard -> /onboarding forever.
        // Looked up with the admin client keyed on the id we just exchanged a
        // code for, because a request-scoped client can't read back the
        // session cookie this same request is still writing. Skipped entirely
        // when the metadata already says contractor: the answer can't change
        // the decision, so it isn't worth the query.
        const hasContractorRow =
          metadataRole === "contractor"
            ? true
            : await contractorRowExists(data.user.id);

        // Does the same account also own a home? Asked in two cases, and
        // skipped otherwise, so an ordinary sign-in already headed somewhere
        // else still costs nothing:
        //
        //   - Of a pro, where it tells a pro-who-also-owns-a-home (both sides
        //     are really theirs, so `next` stands and no stamp is rewritten)
        //     apart from a pro who wandered in through the homeowner door
        //     (bounced to /pro as before).
        //   - Whenever `next` is the claim-your-home wizard, whatever side
        //     they are on. Google and Apple use one button for both sign-up
        //     and sign-in, and /homeowner-signup builds it with
        //     next=/onboarding, so an EXISTING homeowner tapping "Continue
        //     with Apple" landed on the add-another-home screen and got the
        //     free-plan cap wall for doing nothing but signing in. This lookup
        //     is what lets resolveAuthRole recognize them and send them to
        //     their dashboard instead. Without it the answer was false for
        //     every account with no contractors row, which is precisely the
        //     homeowners the wall was hitting.
        const hasPropertyRow =
          hasContractorRow || isFirstHomeSetupPath(next)
            ? await propertyRowExists(data.user.id)
            : false;

        // Everything about who they are and where they go, decided in one
        // pure function (src/lib/roleRouting.ts, re-exported from
        // src/lib/contractor.ts) so the ordering of these signals is testable
        // and lives in one place.
        const decision = resolveAuthRole({
          metadataRole,
          hasContractorRow,
          hasPropertyRow,
          next,
        });

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

        if (decision.needsStamp || needsFullName) {
          const admin = createAdminClient();
          const { error: updateError } = await admin.auth.admin.updateUserById(
            data.user.id,
            {
              user_metadata: {
                ...meta,
                ...(decision.needsStamp && decision.role
                  ? { role: decision.role }
                  : {}),
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
          } else if (decision.needsStamp) {
            // The role we just stamped lives in auth.users, but the session
            // cookie this request set (exchangeCodeForSession above) still
            // holds the pre-stamp JWT. Cookie-based getRole() (the /pro and
            // /pro/onboarding guards read it, not the live auth server) would
            // therefore see the old value and bounce them straight back out
            // of the side they belong on, until the token expired. Refresh the
            // session so the cookie carries the new role BEFORE we redirect.
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

        // The other half of the email-confirmation terms gap (see above):
        // only signup confirmations get a row, and the doc follows the
        // RESOLVED role, so a pro who confirmed through the homeowner door
        // is recorded against the contractor terms they actually signed up
        // under. decision.termsDoc is null for every other use of this route.
        if (decision.termsDoc) {
          await recordTermsAcceptance(data.user.id, decision.termsDoc);
        }

        // decision.redirect covers all three cases: the role picker for
        // someone we know nothing about, the corrected side of the app for a
        // role/destination mismatch, and plain `next` for everyone else.
        return withRecoveryCookie(
          NextResponse.redirect(new URL(decision.redirect, origin))
        );
      }

      return withRecoveryCookie(NextResponse.redirect(new URL(next, origin)));
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=auth_failed`);
}
