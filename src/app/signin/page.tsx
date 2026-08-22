import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/contractor";
import { safeNextPath } from "@/lib/safeNext";
import SignInForm from "./SignInForm";

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
    redirect(
      next ?? ((await getRole()) === "contractor" ? "/pro" : "/dashboard")
    );
  }

  // ?error=auth_failed: set by /auth/callback when a confirmation or magic
  // link couldn't be exchanged for a session (expired or already used), so
  // the form can explain instead of showing a blank sign-in.
  return (
    <SignInForm next={next} authFailed={searchParams?.error === "auth_failed"} />
  );
}
