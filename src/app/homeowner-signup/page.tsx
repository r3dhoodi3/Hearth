"use client";

import Link from "next/link";
import NoticeAtCollection from "@/components/NoticeAtCollection";
import { useState, use } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safeNext";
import { friendlyAuthError } from "@/lib/friendlyAuthError";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import { track } from "@/lib/analytics";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import AppleSignInButton from "@/components/AppleSignInButton";
import PasswordStrengthMeter from "@/components/PasswordStrengthMeter";
import { Eye, EyeOff } from "lucide-react";

// Real per-user sign-up. Creates a Supabase Auth account from the user's email
// + password. If email confirmation is OFF in Supabase, the user is signed in
// immediately and sent to claim their home; if it's ON, we show a
// check-your-inbox panel, and the confirmation link lands on /auth/callback
// with next=/onboarding so verifying drops them straight into onboarding
// instead of back at sign-in.
//
// ?next=: carried in from /get-started (originally from /signin, ultimately
// from the middleware bouncing a signed-out visitor off a gated page). Read
// via the searchParams prop rather than window/useSearchParams so it's
// available with no hydration mismatch or Suspense boundary. Passed through
// to /onboarding on success; the claimed-home gate still routes a brand-new
// homeowner through onboarding first (see onboarding/actions.ts), but their
// destination isn't lost along the way.
//
// ?ref=: a homeowner's personal invite code (migration 0100). It rides along
// to /onboarding exactly the way ?next= does - and exactly the way
// contractor-signup already threads its own ?ref= to /pro/onboarding for the
// pro program - so claimPropertyAction can attribute a first home claim back
// to the neighbor who shared the link. It means nothing outside onboarding,
// so the sign-in / contractor links below keep plain nextQuery.
// searchParams is a Promise since Next 15, and this is a client component, so
// it is unwrapped with React's use() rather than await. Not optional: Next
// always passes it to a page, and `use(undefined)` is a type error (and a
// runtime throw) rather than a graceful fallback. The individual keys stay
// optional, which is what the reads below actually guard against.
export default function HomeownerSignUpPage(props: {
  searchParams: Promise<{ next?: string; ref?: string }>;
}) {
  const searchParams = use(props.searchParams);
  const supabase = createClient();
  const next = safeNextPath(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const ref =
    typeof searchParams?.ref === "string" && searchParams.ref.trim()
      ? searchParams.ref.trim()
      : null;
  // Query string for the /onboarding destination only: next plus ref.
  const onboardingParams = new URLSearchParams();
  if (next) onboardingParams.set("next", next);
  if (ref) onboardingParams.set("ref", ref);
  const onboardingQuery = onboardingParams.toString()
    ? `?${onboardingParams.toString()}`
    : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Show/hide toggle for the single password field. The reveal makes a
  // separate confirm-password field redundant, so there isn't one.
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set when the account exists but email confirmation is still pending;
  // swaps the form for the check-your-inbox panel below.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Unchecked by default (Berman fix: pre-ticked consent boxes are void as an
  // agreement to arbitrate/waive class claims in California). Required
  // before submit; also re-checked in onSubmit, not just via `required`,
  // since a crafted or programmatic submit can bypass HTML validation.
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  // Where the confirmation email's link (and the Google / Apple buttons
  // below) should land: the auth callback exchanges the code for a session,
  // then follows next= to onboarding (with the original ?next= still riding
  // along, double-encoded so it survives the callback's own redirect). The
  // /onboarding prefix also tells the callback this is a signup, not a
  // plain sign-in, so it backfills role=homeowner for a brand-new OAuth
  // user (see src/app/auth/callback/route.ts). Any ?ref= rides along too
  // (onboardingQuery), so an invited neighbor who signs up with Google or
  // Apple is attributed the same as one who used email.
  const oauthNextPath = `/onboarding${onboardingQuery}`;

  function confirmRedirectUrl(): string {
    return `${window.location.origin}/auth/callback?next=${encodeURIComponent(
      oauthNextPath
    )}`;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (!agreedToTerms) {
      setError(
        "Please confirm you're at least 18 and agree to the Terms and Privacy Policy."
      );
      return;
    }

    setBusy(true);

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Name is no longer collected here - it's asked for in onboarding,
        // where it's actually used for the county ownership-of-record match
        // (see src/app/onboarding). Only the role is stamped at creation.
        data: { role: "homeowner" },
        emailRedirectTo: confirmRedirectUrl(),
      },
    });

    if (error) {
      setBusy(false);
      setError(friendlyAuthError(error));
      return;
    }

    // Confirmation OFF → a session is returned immediately → go claim a home.
    if (data.session) {
      // Best-effort audit-trail write; never block signup on it. When email
      // confirmation is ON, no session exists yet here and this never fires -
      // /auth/callback records the acceptance instead, once it exchanges the
      // confirmation code for a session (see the comment there).
      if (data.user) {
        void recordTermsAcceptance(data.user.id, "terms");
      }
      track("signup_homeowner");
      window.location.href = `/onboarding${onboardingQuery}`;
      return;
    }

    // With confirmations ON, signUp for an already-confirmed email does NOT
    // error (enumeration protection): it returns success with an obfuscated
    // user whose identities array is empty, and sends no email. Don't promise
    // an inbox message that will never arrive; point them at sign-in instead.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      setBusy(false);
      setError("An account with this email already exists. Try signing in instead.");
      return;
    }

    // Confirmation ON → no session yet; show the check-your-inbox panel.
    track("signup_homeowner");
    setBusy(false);
    setPendingEmail(email.trim());
  }

  async function onResend() {
    if (!pendingEmail) return;
    setError(null);
    setNotice(null);
    setBusy(true);

    const { error } = await supabase.auth.resend({
      type: "signup",
      email: pendingEmail,
      options: { emailRedirectTo: confirmRedirectUrl() },
    });

    setBusy(false);
    if (error) {
      setError(friendlyAuthError(error));
      return;
    }
    setNotice("Confirmation email resent. Give it a minute or two.");
  }

  // Account created, email confirmation pending: check-your-inbox panel.
  if (pendingEmail) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <div className="card">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
              Check your inbox
            </h1>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              We sent a confirmation link to{" "}
              <span className="break-all font-medium text-stone-700 dark:text-stone-300">{pendingEmail}</span>
              . Click it and you&apos;ll land right in onboarding.
            </p>
          </div>

          <p className="text-center text-xs text-stone-500 dark:text-stone-400">
            Nothing after a couple of minutes? Check your spam folder, or
            resend it.
          </p>
          <button
            type="button"
            onClick={onResend}
            className="btn-secondary mt-4 w-full"
            disabled={busy}
          >
            {busy ? "Resending…" : "Resend email"}
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

          <p className="mt-6 border-t border-stone-100 pt-4 text-center text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">
            Already confirmed, or used the wrong email?{" "}
            <Link href={`/signin${nextQuery}`} className="text-bark-700 hover:underline dark:text-stone-300">
              Sign in
            </Link>{" "}
            or{" "}
            <Link href="/reset-password" className="text-bark-700 hover:underline dark:text-stone-300">
              reset your password
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Start tracking your home with Hearth.
          </p>
        </div>

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
            <div className="relative">
              <input
                id="password"
                className="input pr-10"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="focus-ring absolute inset-y-0 right-0 flex items-center px-3 text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <PasswordStrengthMeter password={password} />
          </div>
          {/* Unchecked-by-default, gated in onSubmit (Berman fix - a
              pre-ticked or merely-decorative agreement line doesn't bind).
              Also carries the 18+ age gate. */}
          <label className="flex items-start gap-2 text-xs text-stone-500 dark:text-stone-400">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              required
            />
            <span>
              I am at least 18 years old and I have read and agree to the{" "}
              <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          {/* Notice at collection - a separate obligation from the checkbox
              above, shown at the point of collection directly under the
              Privacy Policy link. Collapsed by default so it stays tidy. */}
          <NoticeAtCollection
            collects="Your email address and password."
            purpose="create and secure your account, sign you in, and contact you about your home."
            sensitive="Your password is sensitive information. It's stored only as a scrambled hash that we can't reverse, and it's used for nothing but signing you in."
          />
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-stone-200 dark:bg-white/10" />
            <span className="text-xs text-stone-500 dark:text-stone-400">or</span>
            <div className="h-px flex-1 bg-stone-200 dark:bg-white/10" />
          </div>
          <div className="space-y-3">
            <GoogleSignInButton next={oauthNextPath} onError={setError} />
            <AppleSignInButton next={oauthNextPath} onError={setError} />
          </div>
          {/* OAuth signups skip the checkbox above entirely, so the same
              agreement - including the 18+ age representation - needs to be
              restated here instead. Covers both buttons above. */}
          <p className="text-center text-xs text-stone-500 dark:text-stone-400">
            By continuing with Google or Apple you confirm you are 18 or older
            and agree to the{" "}
            <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
              Privacy Policy
            </Link>
            .
          </p>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Creating account…" : "Sign up"}
          </button>
        </form>

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
          <p className="text-sm text-stone-500 dark:text-stone-400">Already have an account?</p>
          <Link
            href={`/signin${nextQuery}`}
            className="btn-secondary mt-2 inline-block w-full"
          >
            Sign in
          </Link>
        </div>
      </div>

      <p className="mt-6 text-center text-xs text-stone-500 dark:text-stone-400">
        Are you a contractor?{" "}
        <Link
          href={`/contractor-signup${nextQuery}`}
          className="text-bark-700 hover:underline dark:text-stone-300"
        >
          Sign up for Hearth for Pros
        </Link>
        .
      </p>
    </main>
  );
}
