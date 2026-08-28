"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createClient as createJsClient } from "@supabase/supabase-js";
import { passwordStatusFor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { setFlash } from "@/lib/flash";
import { friendlyAuthError } from "@/lib/friendlyAuthError";
import { stripe } from "@/lib/stripe";
import { eraseUserData, type EraseSummary } from "@/lib/privacy";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { cappedField, cappedFieldOrNull, FIELD_MAX } from "@/lib/formFields";

// Password re-verification is a brute-force surface: updatePasswordAction,
// updateEmailAction, and deleteAccountAction each take a current password and
// tell the caller whether it was right. Holding the session proves who they
// are, but a borrowed or hijacked one must not get unlimited guesses at the
// password behind it, and the typed-email delete confirmation shouldn't be
// infinitely retryable either. Same fixed-window limiter (migration 0068), but
// UNLIKE the spam-class buckets this one fails CLOSED (see
// passwordAttemptsExhausted): a limiter outage blocks rather than handing a
// borrowed session unlimited tries. One shared bucket across all three actions,
// so attempts can't be spread between them to triple the budget.
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

// Update the current homeowner's identity details: name + phone live in the
// public.users row. Email and password are security concerns and are handled
// only by the /account/security actions below - this action ignores any
// email/password fields a crafted POST might include.
export async function saveAccountAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Trimmed and capped server-side: the inputs' maxLength is a client hint,
  // and a server action takes whatever FormData it is handed.
  const full_name = cappedField(formData, "full_name", FIELD_MAX.name);
  const phone = cappedFieldOrNull(formData, "phone", FIELD_MAX.phone);
  // Checkboxes only appear in FormData when checked, and an unset browser
  // value defaults to "on" - so absence means false, same as the DB default.
  const sms_consent = formData.get("sms_consent") === "on";

  if (!full_name) {
    setFlash("Please enter your name.", "error");
    redirect("/account");
  }

  // Read the current consent flag AND the stored phone first: sms_consent_at
  // should only move forward on a false -> true transition (a fresh grant),
  // never on a save that leaves consent already-true untouched, and never on a
  // revocation - that would erase the record of when consent was originally
  // given (TCPA - see src/lib/notify.ts). Best effort: if migration 0073
  // hasn't reached this database yet the select 42703s, `current` stays null,
  // and priorConsent just defaults to false - harmless, since the update below
  // degrades the exact same way.
  const { data: current } = await supabase
    .from("users")
    .select("sms_consent, phone")
    .eq("id", user.id)
    .maybeSingle();
  const priorConsent = current?.sms_consent === true;

  // CONSENT IS PER NUMBER, not per account. Somebody consented to texts at the
  // number they gave; typing a different one puts a phone that has never
  // agreed to anything on the account, and carrying the old flag over would
  // have Hearth texting a stranger who may now hold that number. TCPA damages
  // are per text, so the flag drops with the number and has to be re-granted.
  //
  // Only when a stored row was actually read (`current`): if the select
  // 42703'd or the row is missing there is no prior number to compare against,
  // and inventing a change would silently switch consent off on a database
  // that is only mid-migration.
  // Trimmed on both sides: the submitted value already went through
  // cappedFieldOrNull's trim, so comparing it against an untrimmed stored
  // string would read pure whitespace as a new number and switch texts off on
  // a save that changed nothing.
  const priorPhone =
    typeof current?.phone === "string" ? current.phone.trim() : null;
  const phoneChanged = !!current && (priorPhone ?? "") !== (phone ?? "");

  const consentFields: {
    sms_consent: boolean;
    sms_consent_at?: string | null;
  } = { sms_consent };
  if (sms_consent && !priorConsent) {
    consentFields.sms_consent_at = new Date().toISOString();
  }
  if (phoneChanged) {
    // Overwrites whatever the two lines above decided, on purpose: a save that
    // both moves the number and ticks the box cannot prove which number was
    // being agreed to. One more save on the settled number turns texts back
    // on, and that one IS unambiguous.
    consentFields.sms_consent = false;
    consentFields.sms_consent_at = null;
  }

  // Name + phone on the caller's OWN session client: they are the two columns
  // an account is meant to be able to rewrite freely, and "users self update"
  // plus migration 0139's guard trigger both allow them.
  const { error: profileError } = await supabase
    .from("users")
    .update({ full_name, phone })
    .eq("id", user.id);
  if (profileError) {
    console.error("saveAccountAction: profile update failed", profileError);
    setFlash("Couldn't save your details just now. Please try again.", "error");
    redirect("/account");
  }

  // SMS CONSENT GOES THROUGH THE ADMIN CLIENT, and that is the point of the
  // split. Migration 0139 locks sms_consent / sms_consent_at (alongside the
  // free-taste counters, email, and the referral columns) against any update
  // that is not the service role: a consent record the consenting account can
  // rewrite at will is not a record, and TCPA damages are per text. So the
  // decision is made HERE, from the verified session, and the write is scoped
  // to that same user.id - never an id from the form.
  //
  // The false -> true rule is unchanged: sms_consent_at only moves on a fresh
  // grant, never on a re-save and never on a revocation, so the date consent
  // was originally given survives.
  //
  // Best effort, and separately: a database without 0073 answers the
  // missing-column fingerprint, in which case there is nothing to store and
  // the name/phone save above still stands. Consent defaults to off in that
  // state, which is the safe direction.
  const { error: consentError } = await createAdminClient()
    .from("users")
    .update(consentFields)
    .eq("id", user.id);
  if (consentError && !isMissingSchemaError(consentError)) {
    console.error("saveAccountAction: consent update failed", consentError);
    setFlash(
      "Saved your details, but your text-message setting didn't stick. Please try that again.",
      "error"
    );
    redirect("/account");
  }

  // Mirror the name into auth metadata too. This is what the toolbar reads, so
  // it's reliable even if the users-table write didn't land - and it's always
  // writable (no RLS).
  //
  // NOTE: password is deliberately NOT handled here. Password changes go only
  // through updatePasswordAction(), which re-verifies the current password.
  // Accepting a `password` field here would let a crafted POST (or a hijacked /
  // shared session) silently reset the password with no re-auth - an account-
  // takeover path - since server actions accept any FormData regardless of the
  // rendered form.
  const { error: authError } = await supabase.auth.updateUser({
    data: { full_name },
  });
  if (authError) {
    setFlash("Couldn't save your name just now. Please try again.", "error");
    redirect("/account");
  }

  // Say so when the number change switched texts off, rather than letting
  // somebody discover it by never getting a reminder. Only when there was
  // something to lose - a person who has never turned texts on does not need
  // to be told to turn them back on.
  if (phoneChanged && (priorConsent || sms_consent)) {
    setFlash(
      "Account updated. Text messages are off for your new number - tick the text-message box again to turn them back on.",
      "info"
    );
  } else {
    setFlash("Account updated.");
  }
  // Revalidate the whole layout tree so the toolbar (in the app layout, not the
  // page) picks up the new name everywhere.
  revalidatePath("/", "layout");
  redirect("/account");
}

// Change the signed-in homeowner's email. Supabase sends a confirmation link
// to the new address; nothing changes until it's clicked.
//
// The sign-in email is where every recovery link goes, so moving it is an
// account-takeover step, not a profile edit. An account that HAS a password
// re-enters it here, verified the same way updatePasswordAction does and
// behind the same pwverify budget, so a borrowed session alone can't start
// walking the account to an attacker's inbox. That check is ours, not the
// Supabase project's: whether the OLD address also has to approve the change
// depends on the "Secure email change" toggle in the dashboard, and this must
// be safe whatever that toggle is set to.
export async function updateEmailAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Read raw and REJECT an over-length address rather than cappedField's silent
  // truncate: this is the routing address every recovery link goes to, and a
  // truncated string still has an "@" and would mail a stranger. A too-long
  // paste is a mistake to stop, not half-keep.
  const email = (formData.get("email") as string | null)?.trim() ?? "";
  if (!email || !email.includes("@")) {
    setFlash("That email address doesn't look right.", "error");
    redirect("/account/security");
  }
  if (email.length > FIELD_MAX.email) {
    setFlash("That email address is too long.", "error");
    redirect("/account/security");
  }
  // Case-insensitive: Supabase stores the address lowercased, so a re-typed
  // "Me@x.com" would slip past an exact === and start a pointless change to the
  // very same mailbox.
  if (user.email && email.toLowerCase() === user.email.toLowerCase()) {
    setFlash("That's already your sign-in email.", "error");
    redirect("/account/security");
  }

  // Which proof this account can actually give, decided from the account's
  // real identities and never from what the form posted - same rule as
  // deleteAccountAction below.
  const { hasPassword } = await passwordStatusFor(user);
  if (hasPassword && user.email) {
    if (await passwordAttemptsExhausted(user.id)) {
      setFlash(PW_VERIFY_MESSAGE, "error");
      redirect("/account/security");
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
      redirect("/account/security");
    }
  }
  // No password on this account (a Google signup that never set one), so
  // there is nothing to re-enter and the confirmation link to the new address
  // is the only proof available. Keep "Secure email change" ON in the Supabase
  // dashboard as defense in depth: that is what also mails the OLD address for
  // approval, which is the protection this branch can't provide itself.

  const { error } = await supabase.auth.updateUser({ email });
  if (error) {
    setFlash(friendlyAuthError(error), "error");
    redirect("/account/security");
  }

  setFlash("Check your new email to confirm the change.");
  redirect("/account/security");
}

// Change the signed-in user's password. Verifies the current password first by
// re-authenticating with a throwaway client (so the live session/cookies aren't
// touched), then checks the new password matches its confirmation.
export async function updatePasswordAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");

  const current = (formData.get("current_password") as string) || "";
  const next = (formData.get("new_password") as string) || "";
  const confirm = (formData.get("confirm_password") as string) || "";

  if (next.length < 8) {
    setFlash("New password must be at least 8 characters.", "error");
    redirect("/account/security");
  }
  if (next !== confirm) {
    setFlash("New passwords don't match.", "error");
    redirect("/account/security");
  }

  if (await passwordAttemptsExhausted(user.id)) {
    setFlash(PW_VERIFY_MESSAGE, "error");
    redirect("/account/security");
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
    redirect("/account/security");
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    setFlash(friendlyAuthError(error), "error");
    redirect("/account/security");
  }

  setFlash("Password updated.");
  redirect("/account/security");
}

// End every session except this one by revoking the other refresh tokens.
// Supabase doesn't expose a per-device session list to us, so this is the
// whole feature: one honest button instead of a fake device list.
export async function signOutOthersAction() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) {
    setFlash(
      "Couldn't sign out your other devices just now. Please try again.",
      "error"
    );
    redirect("/account/security");
  }

  setFlash("Signed out everywhere else. This device stays signed in.");
  redirect("/account/security");
}

// Permanently delete the signed-in homeowner's account, and everything of
// theirs that a plain auth-user delete would leave behind.
//
// eraseUserData() runs FIRST and does the work the FK cascade can't: it
// removes their uploaded files from Storage (no FK or trigger reaches those)
// and deletes the rows whose user reference is ON DELETE SET NULL rather than
// CASCADE - support messages, assistant questions, sent messages, reports -
// each of which keeps personal information in the row itself, so a nulled id
// would not de-identify them. Only then do we delete the auth user, which
// cascades their public.users row and the homes / systems keyed to it.
//
// This is the CCPA right-to-delete path (Cal. Civ. Code 1798.105), so it has
// to actually be complete. Requires re-entering the current password first
// (same bar as updatePasswordAction) so a hijacked / shared session - or a
// stray click - can't destroy the account with no proof of identity; that
// re-auth is also the request verification the regulation asks for. Google
// accounts have no password to re-enter, so they type their email address
// instead; see the branch below.
export async function deleteAccountAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");

  // Which confirmation this account can actually give. An account created with
  // Google has no password to re-enter, so demanding one locked those people
  // out of their own right to delete. The branch is decided HERE, from the
  // account's real identities, never from what the form posted: an account
  // that has a password can't opt into the typed confirmation by leaving the
  // password field out.
  const { hasPassword } = await passwordStatusFor(user);

  // Both branches below, not just the password one: a wrong typed email is
  // cheap to check, but nothing here should be retryable without limit.
  if (await passwordAttemptsExhausted(user.id)) {
    setFlash(PW_VERIFY_MESSAGE, "error");
    redirect("/account/security");
  }

  if (hasPassword) {
    const current = (formData.get("current_password") as string) || "";
    if (!current) {
      setFlash("Current password is incorrect.", "error");
      redirect("/account/security");
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
      // Distinguish a genuinely wrong password from a throttle/network blip:
      // only "invalid login credentials" means the password was wrong. A
      // Supabase sign-in throttle or a dropped connection is NOT the user's
      // password being wrong, and telling them it is sends them retrying a
      // password that was actually correct - on the delete path especially,
      // where a wrong "incorrect password" reading blocks a right-to-delete.
      const msg = /invalid login credentials/i.test(verifyError.message ?? "")
        ? "Current password is incorrect."
        : friendlyAuthError(verifyError);
      setFlash(msg, "error");
      redirect("/account/security");
    }
  } else {
    // No password to check, so the confirmation is typing the account's own
    // email exactly. It isn't a secret, and it isn't meant to be: the point is
    // that nobody destroys an account by clicking one button, and that whoever
    // types it has read which account they're about to delete. Compared here
    // as well as in the browser, because a server action accepts any FormData
    // regardless of what the page rendered.
    const typed = ((formData.get("confirm_email") as string) || "")
      .trim()
      .toLowerCase();
    if (typed !== user.email.toLowerCase()) {
      setFlash(
        "That doesn't match the email on this account. Type it exactly to confirm.",
        "error"
      );
      redirect("/account/security");
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
      redirect("/account");
    }
  }

  // Purge storage objects and the set-null leftovers before the cascade runs.
  // Best effort: if this throws we still delete the account rather than
  // stranding someone who asked to leave, but we don't claim it was clean.
  // A partial purge is logged (there is no audit-log table yet) so the 45-day
  // response record has something to reconstruct what was and wasn't removed.
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
  // A homeowner can also have a contractor listing. contractors.user_id is ON
  // DELETE SET NULL (0005): if its delete failed the whole company record
  // would be orphaned forever once the auth user is gone. Abort before
  // deleteUser rather than leave that behind - same guard as the pro delete
  // path (src/app/pro/profile/actions.ts).
  if (summary?.contractorDeleteFailed) {
    console.error("eraseUserData contractor delete failed for", user.id);
    setFlash(
      "Couldn't fully delete your account. Please try again.",
      "error"
    );
    redirect("/account");
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    setFlash(
      "Couldn't fully delete your account. Please try again, or contact support.",
      "error"
    );
    redirect("/account");
  }

  await supabase.auth.signOut();
  setFlash("Your account has been deleted.");
  redirect("/");
}
