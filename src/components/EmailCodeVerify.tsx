"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyAuthError } from "@/lib/friendlyAuthError";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import Turnstile, {
  CAPTCHA_ENABLED,
  type TurnstileHandle,
} from "@/components/Turnstile";

// Cross-device email verification. Used two ways: inline on the two signup
// pages (they pass the onboarding successHref with ?next/?ref preserved), AND
// standalone on /verify - the recovery screen a reader reaches after closing or
// reloading the tab mid-signup, where successHref is omitted so a verified user
// falls through the root page's role-based routing instead. After signUp() with
// email confirmation ON, Supabase emails a 6-digit code AND a link. We ask for
// the code, not the link, on purpose: the reader can pull the code off their
// phone's inbox and type it here, on the SAME device that started signup, so
// THIS device is the one that verifyOtp() hands the session to and can advance
// into onboarding. A confirmation link opened on the phone would sign the phone
// in and leave the desktop stuck on this screen forever. One shared component
// so homeowner and pro signup get byte-for-byte identical treatment (the
// mobile-parity house rule), differing only in the copy destinations passed in.
//
// The terms doc is DERIVED from the role stamped on the account at signup
// (signUp's options.data.role), not passed in: a contractor gets "pro_terms"
// and everyone else "terms", which is exactly what the signup pages passed
// explicitly before. Sourcing it from the verified user means /verify records
// the right document with no prop, and the two signup pages keep their existing
// per-role behaviour unchanged.
export default function EmailCodeVerify({
  email,
  successHref = "/",
  signInHref = "/signin",
}: {
  email: string;
  // Where to go after verifying. Defaults to "/" so the /verify recovery page
  // lets the root page's landingFor(getSides()) route the now-signed-in user by
  // role (role-less -> role picker, homeowner -> onboarding/dashboard, pro ->
  // /pro/onboarding). The signup pages pass it verbatim, e.g. "/onboarding?...".
  successHref?: string;
  signInHref?: string; // for the "wrong email?" sign-in link, e.g. "/signin?next=..."
}) {
  const supabase = createClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Guards the auto-submit effect so a full 6-digit code fires verify exactly
  // once, not again on every unrelated re-render while the request is in
  // flight. Reset when the code drops back below 6 (a delete/retype).
  const autoSubmitted = useRef(false);
  // Turnstile CAPTCHA token, present only once the widget solves. It gates the
  // resend call ONLY - entering the code (verifyOtp) is not CAPTCHA-protected.
  // No-op when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset: the widget renders
  // nothing, the token stays null, and resend sends captchaToken: undefined.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);

  async function onVerify() {
    if (busy || code.length !== 6) return;
    setError(null);
    setNotice(null);
    setBusy(true);

    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "signup",
    });

    if (error) {
      setBusy(false);
      // Let the auto-submit effect fire again once the reader edits the code.
      autoSubmitted.current = false;
      setError(friendlyAuthError(error));
      return;
    }

    // Verified on THIS device: verifyOtp planted the session here. Record the
    // best-effort terms acceptance (this is the confirmation-ON path, so the
    // signup page's own call never fired), then do a FULL navigation - not the
    // next/navigation router - so the server sees the fresh session cookie on
    // the very next request and drops the reader into onboarding.
    //
    // The doc is derived from the role stamped at signup so this component needs
    // no termsDoc prop and records the identical document per role as before:
    // contractor -> "pro_terms", homeowner (or any other/absent role) -> "terms".
    if (data.user) {
      const role = data.user.user_metadata?.role;
      const doc = role === "contractor" ? "pro_terms" : "terms";
      void recordTermsAcceptance(data.user.id, doc);
    }
    window.location.href = successHref;
  }

  // Auto-submit the moment a full 6-digit code is present, so pasting or a
  // finished type doesn't also require reaching for the button - matched by the
  // Verify button below for anyone who prefers to click.
  useEffect(() => {
    if (code.length === 6 && !busy && !autoSubmitted.current) {
      autoSubmitted.current = true;
      void onVerify();
    }
    if (code.length < 6) {
      autoSubmitted.current = false;
    }
    // onVerify is stable enough for this guarded one-shot; re-run on code/busy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, busy]);

  async function onResend() {
    setError(null);
    setNotice(null);
    setBusy(true);

    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { captchaToken: captchaToken ?? undefined },
    });

    // Turnstile tokens are single-use, so spend it now regardless of outcome; a
    // second resend must solve a fresh one. No-op when the widget isn't rendered.
    turnstileRef.current?.reset();

    setBusy(false);
    if (error) {
      setError(friendlyAuthError(error));
      return;
    }
    setNotice("New code sent. Give it a minute or two.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Enter your code
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            We emailed a 6-digit code to{" "}
            <span className="break-all font-medium text-stone-700 dark:text-stone-300">
              {email}
            </span>
            . Enter it below to finish.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onVerify();
          }}
          className="space-y-4"
        >
          <div>
            <label className="sr-only" htmlFor="code">
              6-digit code
            </label>
            <input
              id="code"
              className="input text-center text-2xl tracking-[0.5em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={busy || code.length !== 6}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
          Nothing after a couple of minutes? Check your spam folder, or resend
          it.
        </p>
        {/* Gates the resend call ONLY (not the Verify button above). Renders
            nothing until NEXT_PUBLIC_TURNSTILE_SITE_KEY is set; when it is, the
            resend stays disabled until the CAPTCHA is solved so we never fire a
            token-required resend with no token. */}
        <Turnstile ref={turnstileRef} onToken={setCaptchaToken} />
        <button
          type="button"
          onClick={onResend}
          className="btn-secondary mt-4 w-full"
          disabled={busy || (CAPTCHA_ENABLED && !captchaToken)}
        >
          {busy ? "Resending…" : "Resend code"}
        </button>

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

        <p className="mt-6 border-t border-stone-100 pt-4 text-center text-xs text-stone-500 max-sm:text-sm dark:border-white/10 dark:text-stone-400">
          Used the wrong email?{" "}
          <Link
            href={signInHref}
            className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300"
          >
            Sign in
          </Link>{" "}
          or{" "}
          <Link
            href="/reset-password"
            className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300"
          >
            reset your password
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
