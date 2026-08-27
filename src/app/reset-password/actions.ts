"use server";

import { cookies } from "next/headers";
import { PW_RECOVERY_COOKIE } from "@/lib/passwordRecovery";

// Clear the recovery cookie once the password has actually been changed, so
// one emailed reset link buys exactly one password change. Without this the
// cookie stands for its full 15 minutes and the "set a new password" form
// stays reachable by URL for the rest of that window - which is the same
// walk-up the cookie exists to close, just with a shorter fuse.
//
// A server action rather than a fetch to a route handler: the cookie is
// httpOnly, so the browser cannot clear it, and this is the smallest surface
// that can. It reads nothing and returns nothing, so calling it when there is
// no cookie is a no-op.
export async function clearPasswordRecoveryAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(PW_RECOVERY_COOKIE);
}
