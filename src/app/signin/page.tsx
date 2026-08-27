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
    searchParams?: Promise<{ next?: string; error?: string }>;
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
  return (
    <>
      {/* Renders nothing. See the note on the homeowner sign-up page: a coarse
          browser fingerprint written to a first-party cookie, for the
          free-trial abuse score, on the account doors only. It is here as well
          as on the sign-up pages because a farmer's second account is often
          created in a browser that has signed in before. */}
      <DeviceFingerprint />
      <SignInForm next={next} authFailed={searchParams?.error === "auth_failed"} />
    </>
  );
}
