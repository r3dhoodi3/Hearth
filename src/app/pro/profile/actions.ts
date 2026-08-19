"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createClient as createJsClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import { passwordStatusFor } from "@/lib/auth";
import { hasProPlan } from "@/lib/subscription";
import { setFlash } from "@/lib/flash";
import { friendlyAuthError } from "@/lib/friendlyAuthError";
import { stripe } from "@/lib/stripe";
import { eraseUserData, type EraseSummary } from "@/lib/privacy";
import { FIELD_MAX } from "@/lib/formFields";

// Password re-verification is a brute-force surface: updatePasswordAction,
// updateEmailAction, and deleteAccountAction each take a current password and
// tell the caller whether it was right. Holding the session proves who they
// are, but a borrowed or hijacked one must not get unlimited guesses at the
// password behind it, and the typed-email delete confirmation shouldn't be
// infinitely retryable either. Same fixed-window limiter (migration 0068) and
// same shared bucket as the homeowner twin in src/app/(app)/account/actions.ts,
// and like it this bucket fails CLOSED (see passwordAttemptsExhausted): a
// limiter outage blocks rather than handing a borrowed session unlimited tries.
const PW_VERIFY_LIMIT = 5;
const PW_VERIFY_WINDOW_SECONDS = 900;
const PW_VERIFY_MESSAGE =
  "Too many attempts. Please wait a few minutes and try again.";

async function passwordAttemptsExhausted(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
    p_bucket: `pwverify:${userId}`,
    p_limit: PW_VERIFY_LIMIT,
    p_window_seconds: PW_VERIFY_WINDOW_SECONDS,
  });
  // This bucket alone fails CLOSED: it guards password guessing and typed-email
  // delete confirmation, so an RPC outage must NOT hand a borrowed session
  // unlimited attempts. Unlike the spam-class buckets (invite/support/quote),
  // where a limiter blip should never lock a real user out, here the safe
  // direction on the unknown is to block. Treat the error as "exhausted."
  if (error) {
    console.error("pwverify rate_limit_hit failed - failing CLOSED:", error);
    return true;
  }
  return allowed === false;
}

// Change the signed-in user's password. Verifies the current password first by
// re-authenticating with a throwaway client (so the live session/cookies aren't
// touched), then checks the new password matches its confirmation.
export async function updatePasswordAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");

  const current = (formData.get("current_password") as string) || "";
  const next = (formData.get("new_password") as string) || "";
  const confirm = (formData.get("confirm_password") as string) || "";

  if (next.length < 8) {
    setFlash("New password must be at least 8 characters.", "error");
    redirect("/pro/profile");
  }
  if (next !== confirm) {
    setFlash("New passwords don't match.", "error");
    redirect("/pro/profile");
  }

  if (await passwordAttemptsExhausted(user.id)) {
    setFlash(PW_VERIFY_MESSAGE, "error");
    redirect("/pro/profile");
  }

  // Verify the current password without disturbing the active session.
  const verifier = createJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  );
  const { error: verifyError } = await verifier.auth.signInWithPassword({
    email: user.email,
    password: current,
  });
  if (verifyError) {
    setFlash("Current password is incorrect.", "error");
    redirect("/pro/profile");
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    setFlash("Couldn't save your changes. Please try again.", "error");
    redirect("/pro/profile");
  }

  setFlash("Password updated.");
  redirect("/pro/profile");
}

// Change the signed-in pro's email. Supabase sends a confirmation link to the
// new address; nothing changes until it's clicked.
//
// The sign-in email is where every recovery link goes, so moving it is an
// account-takeover step, not a profile edit. An account that HAS a password
// re-enters it here, verified the same way updatePasswordAction does and
// behind the same pwverify budget, so a borrowed session alone can't start
// walking the account to an attacker's inbox. That check is ours, not the
// Supabase project's: whether the OLD address also has to approve the change
// depends on the "Secure email change" toggle in the dashboard, and this must
// be safe whatever that toggle is set to. Mirrors the homeowner twin in
// src/app/(app)/account/actions.ts.
export async function updateEmailAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Read raw and REJECT an over-length address rather than cappedField's silent
  // truncate: this is the routing address every recovery link goes to, and a
  // truncated string still has an "@" and would mail a stranger. Mirrors the
  // homeowner twin in src/app/(app)/account/actions.ts.
  const email = (formData.get("email") as string | null)?.trim() ?? "";
  if (!email || !email.includes("@")) {
    setFlash("That email address doesn't look right.", "error");
    redirect("/pro/profile");
  }
  if (email.length > FIELD_MAX.email) {
    setFlash("That email address is too long.", "error");
    redirect("/pro/profile");
  }
  // Case-insensitive: Supabase stores the address lowercased, so a re-typed
  // "Me@x.com" would slip past an exact === and start a pointless change to the
  // very same mailbox.
  if (user.email && email.toLowerCase() === user.email.toLowerCase()) {
    setFlash("That's already your sign-in email.", "error");
    redirect("/pro/profile");
  }

  // Which proof this account can actually give, decided from the account's
  // real identities and never from what the form posted - same rule as
  // deleteAccountAction below.
  const { hasPassword } = await passwordStatusFor(user);
  if (hasPassword && user.email) {
    if (await passwordAttemptsExhausted(user.id)) {
      setFlash(PW_VERIFY_MESSAGE, "error");
      redirect("/pro/profile");
    }

    const current = (formData.get("current_password") as string) || "";
    // Verify the current password without disturbing the active session.
    const verifier = createJsClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    const { error: verifyError } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: current,
    });
    if (verifyError) {
      setFlash("Current password is incorrect.", "error");
      redirect("/pro/profile");
    }
  }
  // No password on this account (a Google signup that never set one), so
  // there is nothing to re-enter and the confirmation link to the new address
  // is the only proof available. Keep "Secure email change" ON in the Supabase
  // dashboard as defense in depth: that is what also mails the OLD address for
  // approval, which is the protection this branch can't provide itself.

  const { error } = await supabase.auth.updateUser({ email });
  if (error) {
    // friendlyAuthError, not error.message: the raw Supabase text is terse
    // jargon and can echo server internals. Same treatment as the homeowner
    // twin in src/app/(app)/account/actions.ts.
    setFlash(friendlyAuthError(error), "error");
    redirect("/pro/profile");
  }

  setFlash("Check your new email to confirm the change.");
  redirect("/pro/profile");
}

// End every session except this one by revoking the other refresh tokens.
// Supabase doesn't expose a per-device session list to us, so this is the
// whole feature: one honest button instead of a fake device list.
export async function signOutOthersAction() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) {
    // Same reasoning as updateEmailAction above: never show raw auth text.
    setFlash(friendlyAuthError(error), "error");
    redirect("/pro/profile");
  }

  setFlash("Signed out everywhere else. This device stays signed in.");
  redirect("/pro/profile");
}

// True only if `raw` is a URL whose origin exactly matches Supabase Storage
// AND whose path is a public object under `pathPrefix`. Parsed with new
// URL() rather than a substring check: a substring check like
// `raw.includes("/pro-logos/<id>/")` is defeated by e.g.
// "https://evil.com/x?y=/pro-logos/<id>/" (the substring is present, but the
// host is attacker-controlled). This is what stops an authenticated pro from
// pointing logo_url at an arbitrary URL - the win-card/review-card routes
// later fetch() this value server-side, so an unvalidated value here is an
// SSRF (cloud metadata, internal services) waiting to happen.
function isOwnedStoragePath(raw: string, pathPrefix: string): boolean {
  if (!raw) return false;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return false;
  try {
    const url = new URL(raw);
    const storageOrigin = new URL(base).origin;
    return url.origin === storageOrigin && url.pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

// Save the free license/insurance details that power the public trust badge
// (/p/<id>). These are a trust signal, NOT a paid perk, so there is deliberately
// no hasProPlan() check here (0109): every pro can list a license and insurance,
// exactly like the free CSLB and background-check badges. The details never
// appear publicly; public_pro_profile (0033) reduces them to booleans. Follows
// the unrestricted saveCompanyAction pattern (no plan gate). A failed write
// (e.g. migration 0033 not applied yet) degrades to a soft flash, not a crash.
export async function saveLicenseInsuranceAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const str = (name: string) => String(formData.get(name) ?? "").trim();

  // The license number is locked once set (same rule as the profile form), so
  // a missing read-only field can't wipe or swap it.
  const license_number = contractor.license_number
    ? contractor.license_number
    : str("license_number").slice(0, 60) || null;

  const stateRaw = str("license_state").toUpperCase();
  if (stateRaw && !/^[A-Z]{2}$/.test(stateRaw)) {
    setFlash("License state should be a 2-letter code, like CA.", "error");
    redirect("/pro/profile");
  }

  const insurance_carrier = str("insurance_carrier").slice(0, 120) || null;

  const expiresRaw = str("insurance_expires");
  if (expiresRaw && Number.isNaN(new Date(expiresRaw).getTime())) {
    setFlash("That insurance expiry date doesn't look right.", "error");
    redirect("/pro/profile");
  }

  const fields: Record<string, unknown> = {
    license_number,
    license_state: stateRaw || null,
    insurance_carrier,
    insurance_expires: expiresRaw || null,
  };
  // Stamp the vault whenever it holds anything, so the badge has a "when".
  if (license_number || stateRaw || insurance_carrier || expiresRaw) {
    fields.license_insurance_updated_at = new Date().toISOString();
  }

  // Cast: the 0033 columns aren't in the generated types (database.types.ts
  // is not regenerated here).
  const { error } = await (supabase.from("contractors") as any)
    .update(fields)
    .eq("id", contractor.id);
  if (error) {
    setFlash(
      "Couldn't save your license and insurance. Please try again.",
      "error"
    );
    redirect("/pro/profile");
  }

  setFlash("License and insurance saved.");
  revalidatePath("/pro/profile");
  redirect("/pro/profile");
}

// Save the Pro-member cosmetics for the public page (/p/<id>): logo and about.
// These dress the page up but are NOT a safety fact, so they stay gated behind
// membership (0109 freed only the license/insurance trust badge, handled by
// saveLicenseInsuranceAction above). Everything is validated here, membership
// is re-checked server-side, and a failed write degrades to a soft flash.
export async function savePublicPageAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  if (!(await hasProPlan())) {
    setFlash("Page extras are a Hearth Pro member perk.", "error");
    redirect("/pro/profile");
  }

  const str = (name: string) => String(formData.get(name) ?? "").trim();

  // About: cap server-side; the textarea's maxLength is only a hint.
  const about = str("about");
  if (about.length > 1000) {
    setFlash("The about section must be 1,000 characters or fewer.", "error");
    redirect("/pro/profile");
  }

  // Logo: only accept a URL that points inside THIS contractor's folder of the
  // pro-logos bucket, so the column can't be pointed at an arbitrary image
  // (and, since this value is later fetch()ed server-side by the win-card and
  // review-card routes, can't be turned into an SSRF).
  const logoRaw = str("logo_url");
  const logo_url = isOwnedStoragePath(
    logoRaw,
    `/storage/v1/object/public/pro-logos/${contractor.id}/`
  )
    ? logoRaw
    : null;

  const fields: Record<string, unknown> = {
    about: about || null,
  };
  // Only overwrite the logo when a new upload came through, so saving the
  // form without touching the logo never clears it.
  if (logo_url) fields.logo_url = logo_url;

  // Cast: the 0033 columns aren't in the generated types (database.types.ts
  // is not regenerated here).
  const { error } = await (supabase.from("contractors") as any)
    .update(fields)
    .eq("id", contractor.id);
  if (error) {
    setFlash("Couldn't save your page extras. Please try again.", "error");
    redirect("/pro/profile");
  }

  setFlash("Public page updated.");
  revalidatePath("/pro/profile");
  redirect("/pro/profile");
}

// Permanently delete the signed-in user's account. Uses the service role to
// remove the auth user (cascading to their public.users row and anything keyed
// to it), then clears the session. Requires re-entering the current password
// first (same bar as updatePasswordAction) so a hijacked / shared session - or
// a stray click - can't destroy the account with no proof of identity. Google
// accounts have no password to re-enter, so they type their email address
// instead; see the branch below.
export async function deleteAccountAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");

  // Which confirmation this account can actually give. A pro who signed up
  // with Google has no password to re-enter, so demanding one locked them out
  // of deleting their own account. Decided HERE, from the account's real
  // identities, never from what the form posted - see the homeowner twin in
  // src/app/(app)/account/actions.ts.
  const { hasPassword } = await passwordStatusFor(user);

  // Both branches below, not just the password one: a wrong typed email is
  // cheap to check, but nothing here should be retryable without limit.
  if (await passwordAttemptsExhausted(user.id)) {
    setFlash(PW_VERIFY_MESSAGE, "error");
    redirect("/pro/profile");
  }

  if (hasPassword) {
    const current = (formData.get("current_password") as string) || "";
    if (!current) {
      setFlash("Current password is incorrect.", "error");
      redirect("/pro/profile");
    }

    // Verify the current password without disturbing the active session.
    const verifier = createJsClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    const { error: verifyError } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: current,
    });
    if (verifyError) {
      setFlash("Current password is incorrect.", "error");
      redirect("/pro/profile");
    }
  } else {
    // No password to check, so the confirmation is typing the account's own
    // email exactly: nobody should be able to destroy a business listing with
    // one click. Compared server-side too, because a server action accepts any
    // FormData regardless of what the page rendered.
    const typed = ((formData.get("confirm_email") as string) || "")
      .trim()
      .toLowerCase();
    if (typed !== user.email.toLowerCase()) {
      setFlash(
        "That doesn't match the email on this account. Type it exactly to confirm.",
        "error"
      );
      redirect("/pro/profile");
    }
  }

  const admin = createAdminClient();

  // Cancel any live Stripe subscription BEFORE deleting the account.
  // subscriptions.user_id is ON DELETE CASCADE (0022), so deleting the auth
  // user drops the row while the card keeps getting billed forever - and the
  // ex-user has no account left to cancel from. If a cancel fails we abort the
  // whole deletion rather than strand a paying subscription with no way out.
  const { data: subs } = await admin
    .from("subscriptions")
    .select("stripe_subscription_id, status")
    .eq("user_id", user.id);
  for (const sub of subs ?? []) {
    if (!sub.stripe_subscription_id || sub.status === "canceled") continue;
    try {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    } catch {
      setFlash(
        "We couldn't cancel your subscription, so we didn't delete your account. Please try again.",
        "error"
      );
      redirect("/pro/profile");
    }
  }

  // Remove the public company listing first so it can't linger as an orphaned
  // record (their wallet/reviews cascade with it; leads simply detach), along
  // with the uploaded logo, licence and insurance documents in Storage - which
  // no FK or trigger reaches - and the rows whose user reference is ON DELETE
  // SET NULL rather than CASCADE. eraseUserData() deletes the contractor row
  // itself, so there's no separate delete here any more.
  //
  // This is the CCPA right-to-delete path (Cal. Civ. Code 1798.105); the
  // password re-auth above doubles as its request verification.
  //
  // NOTE: redirect() throws NEXT_REDIRECT, so the contractor-abort check below
  // lives OUTSIDE this try/catch - a redirect thrown inside it would be
  // swallowed as an "erase failure" and the account would be deleted anyway.
  let summary: EraseSummary | null = null;
  try {
    summary = await eraseUserData(user.id);
  } catch (err) {
    console.error("eraseUserData threw for", user.id, err);
  }
  if (summary && summary.failed.length) {
    console.error(
      "eraseUserData partial purge for",
      user.id,
      "- not removed:",
      summary.failed
    );
  }
  // The contractors row is ON DELETE SET NULL (0005): if its delete failed the
  // whole company record would be orphaned forever once the auth user is gone.
  // Abort before deleteUser rather than leave that behind.
  if (summary?.contractorDeleteFailed) {
    setFlash("Couldn't save your changes. Please try again.", "error");
    redirect("/pro/profile");
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    setFlash("Couldn't save your changes. Please try again.", "error");
    redirect("/pro/profile");
  }

  await supabase.auth.signOut();
  setFlash("Your account has been deleted.");
  redirect("/");
}
