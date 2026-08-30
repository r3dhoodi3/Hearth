"use client";

import Link from "next/link";
import NoticeAtCollection from "@/components/NoticeAtCollection";
import DeviceFingerprint from "@/components/DeviceFingerprint";
import { useState, use } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safeNext";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import AppleSignInButton, {
  APPLE_SIGNIN_ENABLED,
} from "@/components/AppleSignInButton";
import PasswordStrengthMeter from "@/components/PasswordStrengthMeter";
import { LEAD_TIER_FEES, MAJOR_INTRO_FEE } from "@/lib/constants";
import { SIGNUP_EMAIL_NEUTRAL, friendlyAuthError } from "@/lib/friendlyAuthError";
import { Eye, EyeOff } from "lucide-react";

// Real per-user contractor sign-up. Creates a Supabase Auth account tagged with
// role=contractor, then sends them to set up their company. If email
// confirmation is OFF in Supabase they're signed in immediately; if ON, we
// show a check-your-inbox panel, and the confirmation link lands on
// /auth/callback with next=/pro/onboarding so verifying drops them straight
// into company setup instead of back at sign-in.
//
// ?next=: carried in from /get-started same as the homeowner sign-up. Note
// it only survives as far as /pro/onboarding: the company-setup form there
// posts to saveCompanyAction (src/app/pro/actions.ts, owned by another fix),
// which redirects on its own, so a contractor's original destination isn't
// honored past this point. Left alone rather than reaching into that file.
// searchParams is a Promise since Next 15, and this is a client component, so
// it is unwrapped with React's use() rather than await. Not optional: Next
// always passes it to a page, and `use(undefined)` is a type error (and a
// runtime throw) rather than a graceful fallback. The individual keys stay
// optional, which is what the reads below actually guard against.
export default function ContractorSignUpPage(props: {
  searchParams: Promise<{ next?: string; ref?: string }>;
}) {
  const searchParams = use(props.searchParams);
  const supabase = createClient();
  const next = safeNextPath(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  // ?ref=: a referral code from /pros rides along to /pro/onboarding the same
  // way ?next= does (onboarding reads searchParams.ref and redeems it there).
  const ref =
    typeof searchParams?.ref === "string" && searchParams.ref.trim()
      ? searchParams.ref.trim()
      : null;
  // Query string for the /pro/onboarding destination only: next plus ref.
  // The sign-in and homeowner links below keep plain nextQuery, since ref
  // means nothing outside contractor onboarding.
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
  // then follows next= to company setup (with the original ?next= and any
  // ?ref= still riding along, double-encoded so they survive the callback's
  // own redirect). The /pro/onboarding prefix also tells the callback this is
  // a contractor signup, so it backfills role=contractor for a brand-new
  // OAuth user (see src/app/auth/callback/route.ts).
  const oauthNextPath = `/pro/onboarding${onboardingQuery}`;

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
        "Please confirm you're at least 18 and agree to the Contractor Terms and Privacy Policy."
      );
      return;
    }

    setBusy(true);

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { role: "contractor" },
        emailRedirectTo: confirmRedirectUrl(),
      },
    });

    if (error) {
      setBusy(false);
      setError(
        /registered|exists/i.test(error.message)
          ? SIGNUP_EMAIL_NEUTRAL
          : friendlyAuthError(error)
      );
      return;
    }

    // Confirmation OFF → session returned → go set up the company.
    if (data.session) {
      // Best-effort audit-trail write; never block signup on it. When email
      // confirmation is ON, no session exists yet here and this never fires -
      // /auth/callback records the acceptance instead, once it exchanges the
      // confirmation code for a session (see the comment there).
      if (data.user) {
        void recordTermsAcceptance(data.user.id, "pro_terms");
      }
      window.location.href = `/pro/onboarding${onboardingQuery}`;
      return;
    }

    // With confirmations ON, signUp for an already-confirmed email does NOT
    // error (enumeration protection): it returns success with an obfuscated
    // user whose identities array is empty, and sends no email.
    //
    // What we say back is deliberately the SAME sentence either way. Saying
    // "an account with this email already exists" undid Supabase's own
    // enumeration protection in one line, and on this side of the app the
    // answer also maps which local contractors are on the platform. See
    // SIGNUP_EMAIL_NEUTRAL for the reasoning and the wording.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      setBusy(false);
      setNotice(SIGNUP_EMAIL_NEUTRAL);
      return;
    }

    // Confirmation ON → no session yet; show the check-your-inbox panel.
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
              . Click it and you&apos;ll land right in company setup.
            </p>
          </div>

          <p className="text-center text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
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

          <p className="mt-6 border-t border-stone-100 pt-4 text-center text-xs text-stone-500 max-sm:text-sm dark:border-white/10 dark:text-stone-400">
            Already confirmed, or used the wrong email?{" "}
            <Link href={`/signin${nextQuery}`} className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300">
              Sign in
            </Link>{" "}
            or{" "}
            <Link href="/reset-password" className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300">
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
      {/* Renders nothing. See the note on the homeowner sign-up page: a coarse
          browser fingerprint written to a first-party cookie, for the
          free-trial abuse score, on the account doors only. */}
      <DeviceFingerprint />
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Join Hearth for Pros
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Browse local jobs free. Pay only when you apply, $
            {LEAD_TIER_FEES.light}-${LEAD_TIER_FEES.major} by trade, with the
            price on every job card. Your first big-ticket lead is $
            {MAJOR_INTRO_FEE}.
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
              placeholder="you@company.com"
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
                // Phone only: a slightly wider strip and a bigger glyph.
                // The show/hide toggle is how you check what you typed.
                className="focus-ring absolute inset-y-0 right-0 flex items-center px-3 text-stone-400 hover:text-stone-600 max-sm:px-3.5 dark:hover:text-stone-200"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4 max-sm:h-5 max-sm:w-5" />
                ) : (
                  <Eye className="h-4 w-4 max-sm:h-5 max-sm:w-5" />
                )}
              </button>
            </div>
            <PasswordStrengthMeter password={password} />
          </div>
          {/* Every inline link on this page carries max-sm:py-3. Padding on
              an inline element grows the touch area to 44px without changing
              the line box, so the sentences around it do not reflow. */}
          {/* Unchecked-by-default, gated in onSubmit (Berman fix - a
              pre-ticked or merely-decorative agreement line doesn't bind).
              Also carries the 18+ age gate. Links to /pro-terms, not /terms:
              the B2B contractor terms (src/app/pro-terms/page.tsx). */}
          {/* Phone only: 12px consent copy and a 20px box were the smallest
              gate in signup, so the label reads at 14px and the whole row is
              a 44px target. */}
          <label className="flex items-start gap-2 text-xs text-stone-500 max-sm:min-h-11 max-sm:py-1 max-sm:text-sm dark:text-stone-400">
            <input
              type="checkbox"
              // 20px on a phone: the default box is ~13px, which is a miss
              // waiting to happen on the one control that has to be ticked to
              // sign up. Behind max-sm, so desktop keeps the box it had.
              className="mt-0.5 max-sm:h-6 max-sm:w-6 max-sm:shrink-0"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              required
            />
            <span>
              I am at least 18 years old and I have read and agree to the{" "}
              <Link href="/pro-terms" className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300">
                Contractor Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300">
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          {/* Notice at collection - a separate obligation from the checkbox
              above, shown at the point of collection directly under the
              Privacy Policy link. Collapsed by default so it stays tidy. */}
          <NoticeAtCollection
            collects="Your name, email address, and password."
            purpose="create and secure your account, sign you in, and contact you about leads."
            sensitive="Your password is sensitive information. It's stored only as a scrambled hash that we can't reverse, and it's used for nothing but signing you in."
          />
          {/* The primary submit sits directly under the agreement it acts on,
              and above the Google / Apple buttons, so on a 390px phone the
              button that finishes the form the reader just filled in is the
              next thing they reach - not something below two social buttons
              they have to scroll past. The social buttons keep their own
              agreement line underneath them. */}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Creating account…" : "Sign up"}
          </button>
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
              restated here instead. Covers whichever buttons are above: the
              Apple one is hidden until its provider is configured, and naming
              a button that isn't on screen would read as a mistake. Links to
              /pro-terms, same as the checkbox (the B2B contractor terms). */}
          {/* Phone only: for OAuth signups this paragraph IS the agreement,
              so it reads at 14px and its links carry a 44px touch area. */}
          <p className="text-center text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
            By continuing with Google{APPLE_SIGNIN_ENABLED ? " or Apple" : ""}{" "}
            you confirm you are 18 or older and agree to the{" "}
            <Link href="/pro-terms" className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300">
              Contractor Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300">
              Privacy Policy
            </Link>
            .
          </p>
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
        Want to track your own home instead?{" "}
        <Link
          href={`/homeowner-signup${nextQuery}`}
          className="text-bark-700 hover:underline max-sm:py-3 dark:text-stone-300"
        >
          Sign up as a homeowner
        </Link>
        .
      </p>
    </main>
  );
}
