"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "@/lib/friendlyAuthError";
import PasswordStrengthMeter from "@/components/PasswordStrengthMeter";
import { clearPasswordRecoveryAction } from "./actions";

// Password reset, styled to match src/app/signin/page.tsx.
//
// step="request": collect an email and call resetPasswordForEmail. The
// emailed link points at /auth/callback?next=/reset-password?step=update
// (next= is URL-encoded so its own "?" survives), and the callback exchanges
// the code for a recovery session before redirecting here.
//
// step="update": the user is back with that recovery session, so
// supabase.auth.updateUser({ password }) sets the new password. If the link
// expired (no session), updateUser errors and we point them back to step 1.
export default function ResetPasswordForm({
  step,
}: {
  step: "request" | "update";
}) {
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(
        "/reset-password?step=update"
      )}`,
    });

    setBusy(false);
    if (error) {
      setError(friendlyAuthError(error));
      return;
    }
    setNotice(
      `If an account exists for ${email.trim()}, a reset link is on its way. Check spam if it doesn't arrive in a minute or two.`
    );
  }

  async function onUpdate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    // No user_metadata stamp here any more. This form used to also set a
    // password_set marker, and src/lib/auth.ts's heuristicHasPassword read it
    // back - but user_metadata is writable by the account's own browser
    // (this very call is how), so it was a security answer taken from an
    // attacker-controlled field. The real answer comes from
    // current_user_has_password() (migration 0120) reading
    // auth.users.encrypted_password, and that heuristic now fails closed when
    // the read cannot run. Writing the flag would change nothing except leave
    // a stale field lying around for someone to trust again later.
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setBusy(false);
      setError(
        /session/i.test(error.message)
          ? "Your reset link may have expired. Request a new one below."
          : friendlyAuthError(error)
      );
      return;
    }

    // One emailed link, one password change: drop the httpOnly recovery cookie
    // now that the password is actually changed, so /reset-password?step=update
    // stops rendering the form for the rest of the cookie's 15 minutes.
    // Best-effort - the cookie expires on its own, and a failure here must not
    // strand someone who just successfully reset their password.
    try {
      await clearPasswordRecoveryAction();
    } catch {
      // Ignore: the cookie is short-lived either way.
    }

    // They're signed in via the recovery session; "/" routes by role.
    window.location.href = "/";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            {step === "update" ? "Set a new password" : "Reset your password"}
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            {step === "update"
              ? "You're almost back in. Pick a new password below."
              : "Enter your email and we'll send you a link to set a new one."}
          </p>
        </div>

        {step === "update" ? (
          <form onSubmit={onUpdate} className="space-y-4">
            <div>
              <label className="label" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                required
                minLength={8}
              />
              <PasswordStrengthMeter password={password} />
            </div>
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </button>
            <p className="text-center text-xs text-stone-500 dark:text-stone-400">
              Link expired?{" "}
              <Link
                href="/reset-password"
                className="text-bark-700 hover:underline dark:text-stone-300"
              >
                Request a new one
              </Link>
              .
            </p>
          </form>
        ) : (
          <form onSubmit={onRequest} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
            </div>
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            aria-live="polite"
            className="mt-4 rounded-lg bg-bark-50 p-3 text-center text-sm text-bark-700 dark:bg-bark-700/40 dark:text-stone-300"
          >
            {notice}
          </p>
        )}

        <div className="mt-6 border-t border-stone-100 pt-4 text-center dark:border-white/10">
          <p className="text-sm text-stone-500 dark:text-stone-400">Remembered it after all?</p>
          <Link href="/signin" className="btn-secondary mt-2 inline-block w-full">
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
