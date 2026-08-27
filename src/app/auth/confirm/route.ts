import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safeNext";
import { requestOrigin } from "@/lib/requestOrigin";
import {
  PW_RECOVERY_COOKIE,
  passwordRecoveryCookieOptions,
} from "@/lib/passwordRecovery";

// Handles the magic-link click: ?token_hash=...&type=email
// Configure your Supabase email template's confirmation URL to point here:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // ?next= can be seeded by whoever requested the email, and new URL() would
  // happily follow an absolute or //host value, so only accept a same-origin
  // relative path.
  const next = safeNextPath(searchParams.get("next")) ?? "/dashboard";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      // requestOrigin, not request.url: request.url carries the dev server's
      // bind address (`-H 0.0.0.0`) and would strand the browser there.
      const response = NextResponse.redirect(
        new URL(next, requestOrigin(request))
      );
      // Same recovery cookie /auth/callback hands out, for the same reason.
      // Which of the two routes a reset link lands on is decided by the
      // Supabase email template (token_hash lands here, a PKCE code lands
      // there), so the guard on /reset-password?step=update has to be fed from
      // both or turning a template into its other form silently locks people
      // out of their own reset. Only ever set after verifyOtp has SUCCEEDED,
      // so a made-up ?type=recovery with no valid token gets nothing.
      if (type === "recovery") {
        response.cookies.set(
          PW_RECOVERY_COOKIE,
          "1",
          passwordRecoveryCookieOptions()
        );
      }
      return response;
    }
  }

  return NextResponse.redirect(
    new URL("/signin?error=link_invalid", requestOrigin(request))
  );
}
