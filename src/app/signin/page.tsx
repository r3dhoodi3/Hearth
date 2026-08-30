import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSides, landingFor } from "@/lib/contractor";
import { safeNextPath } from "@/lib/safeNext";
import SignInForm from "./SignInForm";
import DeviceFingerprint from "@/components/DeviceFingerprint";

// Server wrapper for sign-in: an already-signed-in user visiting /signin is
// sent straight to where they were headed (?next=) or to their side of the
// app, same pattern as /get-started and the root page, instead of being shown
// the form again. Everyone else gets the client form (./SignInForm.tsx).
export default async function SignInPage(
  props: {
    searchParams?: Promise<{ next?: string; error?: string; expired?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect(next ?? landingFor(await getSides()));
  }

  // ?error=auth_failed: set by /auth/callback when a confirmation or magic
  // link couldn't be exchanged for a session (expired or already used), so
  // the form can explain instead of showing a blank sign-in.
  //
  // link_invalid is the same situation from the other route: /auth/confirm
  // sends it when verifyOtp rejects a token_hash. It was not in this check, so
  // somebody whose emailed reset link had expired landed on a silent sign-in
  // page with no idea why - which is exactly the "the forgot-password link
  // doesn't work" report. Same copy fits both: try signing in, and use Forgot
  // password for a fresh link.
  const authFailed =
    searchParams?.error === "auth_failed" ||
    searchParams?.error === "link_invalid";
  return (
    <>
      {/* Renders nothing. See the note on the homeowner sign-up page: a coarse
          browser fingerprint written to a first-party cookie, for the
          free-trial abuse score, on the account doors only. It is here as well
          as on the sign-up pages because a farmer's second account is often
          created in a browser that has signed in before. */}
      <DeviceFingerprint />
      <SignInForm
        next={next}
        authFailed={authFailed}
        sessionExpired={searchParams?.expired === "1"}
      />
    </>
  );
}
