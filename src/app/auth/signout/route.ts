import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requestOrigin } from "@/lib/requestOrigin";
import { sameOriginGuard } from "@/lib/csrf";
import { ACTIVITY_COOKIE } from "@/lib/sessionActivity";

export async function POST(request: NextRequest) {
  // CSRF. Signing somebody out is a low-value forgery, but it is still a state
  // change reachable by a plain cross-site form post (this route takes no JSON
  // body, so it has no preflight protecting it), and being logged out mid-task
  // by a page you visited is a real annoyance. src/lib/csrf.ts only rejects on
  // positive cross-site evidence, so the app's own sign-out form is unaffected.
  const crossSite = sameOriginGuard(request);
  if (crossSite) return crossSite;

  const supabase = await createClient();
  await supabase.auth.signOut();
  // Land on the public landing page (neutral for both homeowner and pro).
  // Origin from requestOrigin, not request.url: the latter carries the dev
  // server's bind address (`-H 0.0.0.0`) and strands the browser there.
  const response = NextResponse.redirect(new URL("/", requestOrigin(request)), {
    status: 303,
  });
  // Drop the idle-timeout stamp with the session it belongs to. Without this a
  // browser that signed out and came back more than 30 days later would sign in
  // successfully and then be bounced straight back to /signin by the idle check
  // reading a stamp that belonged to the previous session. See
  // src/lib/sessionActivity.ts.
  response.cookies.delete(ACTIVITY_COOKIE);
  return response;
}
