"use client";

import Link from "next/link";
import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safeNext";
import { friendlyAuthError } from "@/lib/friendlyAuthError";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import AppleSignInButton from "@/components/AppleSignInButton";
import Turnstile, {
  CAPTCHA_ENABLED,
  type TurnstileHandle,
} from "@/components/Turnstile";

// Read ?next= straight off the browser URL (used at submit time). Guarded by
// the shared safeNextPath so a malicious absolute/protocol-relative value
// never gets followed.
function currentNextPath(): string | null {
  if (typeof window === "undefined") return null;
  return safeNextPath(new URLSearchParams(window.location.search).get("next"));
}

// Unified sign-in form for everyone. After authentication we send the user to
// the page they were originally headed to (?next=, set by the middleware when
// it bounced them here), or to "/", which reads their role and routes
// homeowners to /dashboard and contractors to /pro - so a single sign-in
// works for both sides. The server wrapper (./page.tsx) handles the
// already-signed-in case before this form ever renders.
export default function SignInForm({
  next,
  authFailed,
  sessionExpired,
}: {
  next: string | null;
  // Set when /auth/callback couldn't exchange the link's code for a session
  // (?error=auth_failed). Two very different situations land here and the
  // callback can't tell them apart: (1) a link that genuinely expired or was
  // already used, and (2) a confirmation or set-password link opened on a
  // DIFFERENT device from the one that requested it. Case 2 is common and
  // benign: the PKCE code_verifier cookie lives only in the browser that
  // started the flow, so exchangeCodeForSession fails on the other device even
  // though the account was already confirmed - signing in just works. The copy
  // below has to read as true in both cases, so it points at signing in first
  // rather than shouting "expired," which was wrong (and alarming) for case 2.
  authFailed?: boolean;
  // Set when the middleware ended a session that had gone 30 days unused
  // (?expired=1, see src/lib/sessionActivity.ts). Nothing went wrong and
  // nothing was lost, so the copy says exactly that instead of reading like an
  // error.
  sessionExpired?: boolean;
}) {
  const supabase = createClient();
  // "New to Hearth?" sends visitors to the home page (the landing with the
  // hero photos and both role doors), which is now the single front door for
  // new users. It does not carry ?next= - the landing has no destination to
  // thread on - so a signed-out visitor who arrived via a gated CTA and then
  // chooses to sign up starts fresh from the landing. `next` is still used
  // below for the actual sign-in and the Google/Apple buttons.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set to the typed email when sign-in fails specifically because the account
  // was created but its email was never confirmed. Turns what used to be a dead
  // end (the "email not confirmed" error with nowhere to go) into a link out to
  // /verify, where the reader can enter or resend their 6-digit code. Cleared
  // on every fresh submit so a later wrong-password attempt doesn't keep it up.
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  // Turnstile CAPTCHA token, present only once the widget solves. No-op when
  // NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset: the widget renders nothing, the
  // token stays null, and signInWithPassword sends captchaToken: undefined.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setUnconfirmedEmail(null);
    setBusy(true);

    const trimmedEmail = email.trim();
    const { error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
      options: { captchaToken: captchaToken ?? undefined },
    });

    // Turnstile tokens are single-use, so spend it now regardless of outcome; a
    // second attempt must solve a fresh one. No-op when the widget isn't rendered.
    turnstileRef.current?.reset();

    if (error) {
      setBusy(false);
      setStatus(friendlyAuthError(error));
      // Supabase reports an unconfirmed account as message "Email not confirmed"
      // (code "email_not_confirmed" on newer versions). Match either, case- and
      // wording-tolerantly, and offer the way out. The friendly error above
      // still shows; this only ADDS the CTA.
      const code =
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "";
      if (
        /not confirmed/i.test(error.message) ||
        code === "email_not_confirmed"
      ) {
        setUnconfirmedEmail(trimmedEmail);
      }
      return;
    }

    // Back to where they were headed, or "/" for role-based routing.
    window.location.href = currentNextPath() ?? "/";
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Sign in to Hearth
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Homeowners and contractors, same sign-in.
          </p>
        </div>

        {sessionExpired && (
          <p
            role="status"
            className="mb-4 rounded-lg border border-stone-200 bg-stone-50 p-3 text-center text-sm text-stone-700 dark:border-white/10 dark:bg-white/5 dark:text-stone-300"
          >
            You were signed out because this device had not used Hearth in a
            while. Sign in again to pick up where you left off.
          </p>
        )}

        {authFailed && (
          <p
            role="status"
            className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-center text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200"
          >
            If you just confirmed your email or opened a link from another
            device, try signing in below - it probably worked already. If a
            link really did expire, use Forgot password to get a fresh one.
          </p>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
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
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {/* Phone only: 16px tall, right-aligned. This is the recovery
                path for someone who cannot read what they typed. */}
            <p className="mt-1.5 text-right text-xs max-sm:text-sm">
              <Link
                href="/reset-password"
                className="text-bark-700 hover:underline max-sm:-mr-2 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-2 dark:text-stone-300"
              >
                Forgot password?
              </Link>
            </p>
          </div>
          {/* Renders nothing until NEXT_PUBLIC_TURNSTILE_SITE_KEY is set. When
              it is, the submit stays disabled until the CAPTCHA is solved so we
              never fire a token-required sign-in with no token. */}
          <Turnstile ref={turnstileRef} onToken={setCaptchaToken} />
          <button
            className="btn-primary w-full"
            disabled={busy || (CAPTCHA_ENABLED && !captchaToken)}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {status && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            {status}
          </p>
        )}

        {/* The way out of the old dead end: an account created but never
            email-verified used to hit "Email not confirmed" with nowhere to go.
            /verify carries the typed email so the code panel opens on it
            directly and can enter or resend the 6-digit code. */}
        {unconfirmedEmail && (
          <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3 text-center dark:border-white/10 dark:bg-white/5">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              This account still needs its email verified.
            </p>
            <Link
              href={`/verify?email=${encodeURIComponent(unconfirmedEmail)}`}
              className="btn-secondary mt-3 flex w-full"
            >
              Verify your email
            </Link>
          </div>
        )}

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-stone-200 dark:bg-white/10" />
          <span className="text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">or</span>
          <div className="h-px flex-1 bg-stone-200 dark:bg-white/10" />
        </div>

        <div className="space-y-3">
          <GoogleSignInButton next={next} onError={setStatus} />
          <AppleSignInButton next={next} onError={setStatus} />
        </div>

        <div className="mt-6 border-t border-stone-100 pt-4 text-center dark:border-white/10">
          <p className="text-sm text-stone-500 dark:text-stone-400">New to Hearth?</p>
          <Link
            href="/"
            className="btn-secondary mt-2 flex w-full"
          >
            Get started
          </Link>
        </div>
      </div>
    </main>
  );
}
