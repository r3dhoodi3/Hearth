"use server";

import { createClient } from "@/lib/supabase/server";
import { requestOriginFromHeaders } from "@/lib/requestOrigin";
import { friendlyAuthError } from "@/lib/friendlyAuthError";

// Not exported: a "use server" module may only export async functions, and
// the one caller (AccountSecurityPanel) infers this from the return type.
interface SetPasswordLinkResult {
  ok: boolean;
  message: string;
}

// Email the signed-in user a link that lets them set a password, for accounts
// created with Google that have never had one (see getPasswordStatus in
// src/lib/auth.ts). Shared by both sides of the app: the homeowner security
// page and the pro profile's Account Security tab render the same panel, and
// this action does the same thing for both.
//
// WHY AN EMAILED LINK, AND NOT A DIRECT supabase.auth.updateUser({ password }):
// setting a password ADDS a new way to sign in to the account. The recovery
// email proves the person still controls the mailbox before that happens, so
// someone who walks up to an unlocked browser with a live session can't quietly
// give themselves a permanent password on somebody else's account. Please
// don't "simplify" this into a password field that writes straight through -
// the round trip through email is the entire security value of the flow.
//
// The link points at the existing /reset-password?step=update page, so the
// strength meter and the 8-character minimum are the same ones every other
// password change goes through.
export async function sendSetPasswordLinkAction(): Promise<SetPasswordLinkResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return {
      ok: false,
      message: "Please sign in again, then try that once more.",
    };
  }

  // The address on the account, never anything the browser sent us: this
  // action takes no arguments on purpose, so there is no way to aim the link
  // at a mailbox the signed-in user doesn't already own.
  const origin = await requestOriginFromHeaders();
  const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(
      "/reset-password?step=update"
    )}`,
  });

  // Supabase throttles these emails (one a minute per address by default).
  // Say so honestly rather than pretending the send worked - friendlyAuthError
  // already turns that cooldown into plain copy.
  if (error) return { ok: false, message: friendlyAuthError(error) };

  return {
    ok: true,
    message: `Check ${user.email} for a link to set your password. If it hasn't arrived in a minute or two, look in your spam folder.`,
  };
}
