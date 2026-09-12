import type { Metadata } from "next";
import { cookies } from "next/headers";
import ResetPasswordForm from "./ResetPasswordForm";
import { PW_RECOVERY_COOKIE } from "@/lib/passwordRecovery";

// Server wrapper so the route can export metadata; the form itself is a
// client component. Two steps in one route:
//   /reset-password              → ask for an email, send the recovery link
//   /reset-password?step=update  → back from the emailed link (via
//                                  /auth/callback or /auth/confirm, which
//                                  turn the code into a recovery session) →
//                                  set a new password.
//
// The update step needs BOTH signals: ?step=update AND the httpOnly
// oaktend_pwrecovery cookie one of those two auth routes sets when it has just
// completed a recovery exchange. The query string alone used to be enough,
// which meant anyone sitting at an already-signed-in browser could type the
// URL and change the password without knowing the old one - see the note in
// src/lib/passwordRecovery.ts. With no cookie the page falls back to step one
// (ask for an email), which is the honest thing to show someone who arrived
// here without a live reset link, and it tells an attacker nothing.
export const metadata: Metadata = {
  // The root layout's title template appends "| OakTend"; don't repeat it here.
  title: "Reset your password",
  description:
    "Forgot your OakTend password? Enter your email and we'll send you a link to set a new one.",
};

// The cookie read makes this route dynamic; that is correct for a page whose
// rendered step depends on a per-request cookie, and it was already dynamic in
// practice (nothing here is cacheable per user).
export default async function ResetPasswordPage(
  props: {
    searchParams?: Promise<{ step?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const cookieStore = await cookies();
  // The NEW name only, with no pre-rename fallback. This cookie lives 15
  // minutes, so no legacy value can still be valid by the time a deploy is
  // live, and accepting the old name would mean this gate - the one thing
  // standing between "typed the URL" and "change the password" - could be
  // satisfied by a name nothing writes any more. src/app/reset-password/
  // actions.ts still DELETES both names, which is the half that has to stay.
  const hasRecovery = cookieStore.get(PW_RECOVERY_COOKIE)?.value === "1";
  return (
    <ResetPasswordForm
      step={
        searchParams?.step === "update" && hasRecovery ? "update" : "request"
      }
    />
  );
}
