"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import PasswordStrengthMeter from "@/components/PasswordStrengthMeter";
import { sendSetPasswordLinkAction } from "@/lib/passwordSetup";

// The one account-security surface, shared by the homeowner page
// (/account/security) and the pro profile's Account Security tab so the two
// sides can't drift apart. Everything security-shaped lives here and only
// here: sign-in email, password, sessions, data export, and deletion.
// Profile identity (name, phone) stays on the Edit profile side.
//
// The server actions are passed in as props because each side has its own
// (they redirect back to their own page after the flash).

type Action = (formData: FormData) => void;
type PlainAction = () => void;

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function FieldIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-500">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

const keyIcon = (
  <>
    <circle cx="8" cy="8" r="5" />
    <path d="M11.5 11.5L21 21M16 16l2-2M18 18l2-2" />
  </>
);
const lockSmall = (
  <>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </>
);
const mailIcon = <path d="M4 4h16v16H4zM4 6l8 6 8-6" />;

// What the Password card shows for an account that has no password: someone
// who signed up with Google has nothing to type into "Current password", so
// the normal form is a dead end for them. This offers the way out instead.
//
// The action is imported rather than passed in as a prop like the others,
// because unlike them it does the same thing on both sides of the app: it
// sends an email and returns, with no redirect back to a side-specific page.
function SetPasswordCard({ providerName }: { providerName: string }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Supabase only lets one recovery email out per address per minute, so the
  // button sits out that minute rather than firing a request it knows the
  // throttle will reject. It also stops a double-click sending twice.
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function send() {
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError(null);
    // finally, not a bare setBusy(false) on the happy path:
    // sendSetPasswordLinkAction can THROW rather than return an ok:false
    // (a missing Host header, a dropped connection), and if it did, busy
    // stayed true forever and every later click was a silent no-op. Clearing
    // it in finally guarantees the button comes back, and the catch turns the
    // throw into a message instead of nothing.
    try {
      const result = await sendSetPasswordLinkAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSent(result.message);
      setCooldown(60);
    } catch {
      setError("Couldn't send that link just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 max-w-md space-y-4">
      <p className="text-sm text-stone-600 dark:text-stone-300">
        You signed in with {providerName}, so there&apos;s no password on this
        account yet. {providerName} sign-in keeps working either way.
      </p>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Want to sign in with your email and a password too? We&apos;ll email you
        a link to set one. Opening that link is how we check the mailbox is
        really yours.
      </p>

      {sent ? (
        <div className="space-y-3">
          <p
            aria-live="polite"
            className="rounded-lg bg-bark-50 p-3 text-sm text-bark-700 dark:bg-bark-700/40 dark:text-stone-300"
          >
            {sent}
          </p>
          <button
            type="button"
            onClick={send}
            disabled={busy || cooldown > 0}
            className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? "Sending…"
              : cooldown > 0
                ? `Send it again in ${cooldown}s`
                : "Send it again"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={busy || cooldown > 0}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Sending…" : "Set a password"}
        </button>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export default function AccountSecurityPanel({
  email,
  updateEmailAction,
  updatePasswordAction,
  signOutOthersAction,
  deleteAccountAction,
  privacyHref,
  hasPassword,
  providerName,
}: {
  // The address the person signs in with today, shown so they know what
  // they're changing from.
  email: string | null;
  updateEmailAction: Action;
  updatePasswordAction: Action;
  signOutOthersAction: PlainAction;
  deleteAccountAction: Action;
  // This side's privacy-rights page. Homeowners and pros have separate routes
  // (the (app) layout bounces pros out of /account), so the link is a prop.
  privacyHref: string;
  // Whether this account can sign in with a password at all. False for Google
  // signups that never set one, and the Password card swaps to the set-a-
  // password flow instead of a form asking for a password they don't have.
  // Read fresh on every page load (getPasswordStatus in src/lib/auth.ts), so
  // it flips back to the normal form as soon as a password exists.
  hasPassword: boolean;
  // How they do sign in today ("Google"), for the copy in that card.
  providerName: string;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Local mirror of the new-password field, only so the strength meter below
  // it has something to read. The input stays a normal uncontrolled form
  // field for the server action (name="new_password" still submits via
  // FormData) - value/onChange here don't change that.
  const [newPassword, setNewPassword] = useState("");
  // Deletion confirmation for accounts with no password (Google signups): they
  // type their own email address instead of a password they don't have. The
  // delete button stays disabled until it matches, so the last click is never
  // an accident. deleteAccountAction re-checks the same thing server-side.
  const [confirmEmail, setConfirmEmail] = useState("");
  const confirmEmailMatches =
    !!email && confirmEmail.trim().toLowerCase() === email.toLowerCase();

  return (
    <div className="space-y-6">
      {/* Sign-in email. Changing it is a security action (it moves where
          recovery links go), so it lives here, not on Edit profile. */}
      <div className="card p-6">
        <div className="flex items-center gap-2 border-b border-stone-100 pb-4 dark:border-white/10">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-stone-800 dark:text-stone-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {mailIcon}
          </svg>
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            Sign-in email
          </h2>
        </div>

        <form action={updateEmailAction} className="mt-5 max-w-md space-y-4">
          {email && (
            <p className="text-sm text-stone-600 dark:text-stone-300">
              You currently sign in as{" "}
              <span className="font-medium text-stone-900 dark:text-stone-100">{email}</span>.
            </p>
          )}
          <div>
            <label className="label">New Email Address</label>
            <div className="relative">
              <FieldIcon>{mailIcon}</FieldIcon>
              <input
                name="email"
                type="email"
                autoComplete="email"
                className="input pl-9"
                placeholder="you@example.com"
                required
              />
            </div>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              We send a confirmation link to the new address. Nothing changes
              until you click it.
            </p>
          </div>
          {/* Your sign-in email is where password resets go, so changing it
              needs the same proof as changing the password itself. Accounts
              with no password (a Google signup) have nothing to type here, so
              the field is skipped for them and the confirmation link is the
              proof. The server action checks this the same way. */}
          {hasPassword && (
            <div>
              <label className="label">Current Password</label>
              <div className="relative">
                <FieldIcon>{keyIcon}</FieldIcon>
                <input
                  name="current_password"
                  type="password"
                  autoComplete="current-password"
                  className="input pl-9"
                  placeholder="Enter current password"
                  required
                />
              </div>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                We ask for this so nobody else can move your sign-in email.
              </p>
            </div>
          )}
          <SubmitButton className="btn-primary" pendingLabel="Updating…">
            Update Email
          </SubmitButton>
        </form>
      </div>

      {/* Password */}
      <div className="card p-6">
        <div className="flex items-center gap-2 border-b border-stone-100 pb-4 dark:border-white/10">
          <LockIcon className="h-5 w-5 text-stone-800 dark:text-stone-400" />
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">Password</h2>
        </div>

        {!hasPassword ? (
          <SetPasswordCard providerName={providerName} />
        ) : (
          <form action={updatePasswordAction} className="mt-5 max-w-md space-y-4">
            <div>
              <label className="label">Current Password</label>
              <div className="relative">
                <FieldIcon>{keyIcon}</FieldIcon>
                <input
                  name="current_password"
                  type="password"
                  autoComplete="current-password"
                  className="input pl-9"
                  placeholder="Enter current password"
                  required
                />
              </div>
            </div>
  
            <div>
              <label className="label">New Password</label>
              <div className="relative">
                <FieldIcon>{lockSmall}</FieldIcon>
                <input
                  name="new_password"
                  type="password"
                  autoComplete="new-password"
                  className="input pl-9"
                  placeholder="At least 8 characters"
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <PasswordStrengthMeter password={newPassword} />
            </div>
  
            <div>
              <label className="label">Confirm New Password</label>
              <div className="relative">
                <FieldIcon>{lockSmall}</FieldIcon>
                <input
                  name="confirm_password"
                  type="password"
                  autoComplete="new-password"
                  className="input pl-9"
                  placeholder="Confirm new password"
                  minLength={8}
                  required
                />
              </div>
            </div>
  
            <SubmitButton className="btn-primary" pendingLabel="Updating…">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                <path d="M17 21v-8H7v8M7 3v5h8" />
              </svg>
              Update Password
            </SubmitButton>
          </form>
        )}
      </div>

      {/* Sessions. Supabase doesn't give us a per-device session list from
          here, so we offer the action that matters instead of a fake list. */}
      <div className="card p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Sign out of other devices
            </p>
            <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
              Left yourself signed in somewhere, or see activity you don&apos;t
              recognize? This ends every session except this one.
            </p>
          </div>
          <form action={signOutOthersAction}>
            <SubmitButton className="btn-secondary whitespace-nowrap" pendingLabel="Signing out…">
              Sign out everywhere else
            </SubmitButton>
          </form>
        </div>
      </div>

      {/* Data export. A real download now: /api/privacy/export builds the
          file from the caller's own session, so being signed in IS the
          verification and there's nothing to wait for. Plain <a download>
          rather than a form, because the route streams a file back instead of
          redirecting. */}
      <div className="card p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Export your data
            </p>
            <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
              Download everything we hold for your account as a JSON file.{" "}
              <Link href={privacyHref} className="font-medium text-bark-700 hover:underline dark:text-stone-300">
                Your privacy rights
              </Link>{" "}
              explains what&apos;s in it.
            </p>
          </div>
          <a
            href="/api/privacy/export"
            download
            className="btn-secondary whitespace-nowrap"
          >
            Download my data
          </a>
        </div>
      </div>

      {/* Account deletion. No "Danger Zone" caption, per design direction. */}
      <div className="card p-6">
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Delete your account
              </p>
              <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                Permanently remove your account and all associated data. This
                action cannot be undone.
              </p>
            </div>
            {!confirmingDelete && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="whitespace-nowrap rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
              >
                Delete Account
              </button>
            )}
          </div>

          {confirmingDelete && (
            <form
              action={deleteAccountAction}
              className="mt-4 max-w-md space-y-4 border-t border-red-200 pt-4 dark:border-red-900/50"
            >
              <p className="text-sm font-bold text-red-800 dark:text-red-300">
                This permanently deletes your account, your homes, systems,
                documents, and messages. This cannot be undone.
              </p>
              {hasPassword ? (
                <div>
                  <label className="label">Enter your password to confirm</label>
                  <div className="relative">
                    <FieldIcon>{keyIcon}</FieldIcon>
                    <input
                      name="current_password"
                      type="password"
                      autoComplete="current-password"
                      className="input pl-9"
                      placeholder="Current password"
                      required
                    />
                  </div>
                </div>
              ) : (
                /* No password on this account, so there's nothing to re-enter.
                   Typing the address instead is the deliberate step: it makes
                   sure the person has read WHICH account is about to go, which
                   a lone red button never does. The server checks it too. */
                <div>
                  <label className="label" htmlFor="confirm_email">
                    Type your email address to confirm
                  </label>
                  <div className="relative">
                    <FieldIcon>{mailIcon}</FieldIcon>
                    <input
                      id="confirm_email"
                      name="confirm_email"
                      type="email"
                      autoComplete="off"
                      spellCheck={false}
                      className="input pl-9"
                      placeholder="you@example.com"
                      value={confirmEmail}
                      onChange={(e) => setConfirmEmail(e.target.value)}
                      required
                    />
                  </div>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    You&apos;re deleting the Hearth account for{" "}
                    <span className="font-medium text-stone-900 dark:text-stone-100">
                      {email ?? "this address"}
                    </span>
                    , the one you sign in to with {providerName}. Your account
                    with {providerName} isn&apos;t touched.
                  </p>
                </div>
              )}
              <div className="flex items-center gap-3">
                <SubmitButton
                  className="whitespace-nowrap rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  pendingLabel="Deleting…"
                  disabled={!hasPassword && !confirmEmailMatches}
                >
                  Permanently delete account
                </SubmitButton>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingDelete(false);
                    setConfirmEmail("");
                  }}
                  className="btn-secondary whitespace-nowrap"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
