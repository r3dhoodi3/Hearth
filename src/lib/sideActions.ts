"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSides } from "@/lib/contractor";
import { setFlash } from "@/lib/flash";

// Switches which side of Hearth this account lands on, from the profile menu
// in either nav (Nav.tsx / ProNav.tsx post to it).
//
// This is the ONE sanctioned way to change the side an ESTABLISHED account
// lands on. /welcome/role's chooseRoleAction refuses that outright: it stops
// the moment either row exists, so it only ever serves someone who has built
// nothing yet (no side at all, or a stamp with nothing behind it). The
// difference here is that this action can only ever move someone to a side
// they demonstrably ALREADY HAVE (a contractors row, or a home), so it grants
// nothing: it only records which of their two existing sides they want to open
// on next time. Between the two, no path can hand an account a side it has not
// actually set up.
export async function setPreferredSideAction(formData: FormData) {
  // Re-auth server-side rather than trusting the form: this is reachable by a
  // crafted POST, so identity comes from the verified session only.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const submitted = formData.get("side");
  if (submitted !== "homeowner" && submitted !== "contractor") {
    redirect("/dashboard");
  }
  const side = submitted;

  // The account must actually hold the side it is asking to prefer. A forged
  // post from a homeowner asking for "contractor" gets no stamp at all - it is
  // sent to the setup flow for that side instead, which is the only way to
  // acquire it (and which records the right terms acceptance on the way).
  const sides = await getSides();

  // `checked` is false only when the hasPro/hasHome lookups themselves could
  // not be completed (a DB outage), not when they legitimately came back
  // empty - see the comment on Sides.checked in src/lib/contractor.ts. Without
  // this guard, a transient read failure reports both sides as false, and a
  // real dual-sided user (someone who genuinely owns both a contractors row
  // and a home) gets misrouted into re-running the setup flow for a side they
  // already have, on a preference switch that should have been a no-op.
  // Mirrors the same guard in chooseRoleAction (src/app/welcome/role/
  // actions.ts): refuse and ask for a retry rather than act on a check that
  // never actually ran.
  if (sides.checked === false) {
    await setFlash(
      "We couldn't check your account just now. Try again in a minute.",
      "error"
    );
    // "/", not either shell directly: this account may hold the OTHER side
    // too, and a failed check here says nothing about which. "/" re-derives
    // the landing from a fresh getSides() call (src/app/page.tsx), which is
    // the same self-correcting redirect every other landing decision in the
    // app relies on.
    redirect("/");
  }

  const has = side === "contractor" ? sides.hasPro : sides.hasHome;
  if (!has) {
    redirect(side === "contractor" ? "/pro/onboarding" : "/onboarding?add=home");
  }

  // Already their preference: skip the write and the session refresh.
  if (sides.preferred !== side) {
    // Merge, don't replace, so full_name and friends survive - same merge
    // /auth/callback and chooseRoleAction do.
    const meta = user.user_metadata ?? {};
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...meta, role: side },
    });
    if (error) {
      // Not fatal: the stamp only decides where they land by default, and both
      // sides stay reachable either way, so send them across anyway rather
      // than blocking the switch on a metadata write.
      console.error("setPreferredSideAction: failed to stamp side", {
        userId: user.id,
        side,
        error,
      });
    } else {
      // The new role lives in auth.users, but this request's session cookie
      // still holds the pre-stamp JWT, which is what getRole()/getSides() read.
      // Refresh so the cookie carries the new preference before we redirect.
      const { error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) {
        console.error(
          "setPreferredSideAction: failed to refresh session after stamp",
          refreshError
        );
      }
    }
  }

  redirect(side === "contractor" ? "/pro" : "/dashboard");
}
