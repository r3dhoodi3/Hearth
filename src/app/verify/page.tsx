"use client";

import { useState, use } from "react";
import EmailCodeVerify from "@/components/EmailCodeVerify";

// The stable, recoverable email-verification screen. It exists so a closed or
// reloaded signup tab can never strand anyone: the code-entry panel used to
// live only in the signup page's in-memory React state (pendingEmail), so once
// that page was gone the account sat created-but-unconfirmed with no way back -
// sign-in said "email not confirmed" and dead-ended. This page is that way
// back. It is reachable two ways: from the sign-in "email not confirmed"
// fallback (which links here with ?email=), and directly by URL.
//
// EmailCodeVerify already carries the resend button, so we do NOT auto-resend a
// code on load: an auto-resend would fire Supabase's rate limit / abuse guard
// for anyone who reloads this page, and the reader most likely still has the
// code from signup in their inbox. They enter it or tap Resend themselves.
//
// searchParams is a Promise since Next 15, and this is a client component, so
// it is unwrapped with React's use() rather than await - the same pattern the
// signup pages use. The individual keys stay optional, which is what the read
// below guards against.
//
// Client component, so there is no metadata export (Next only reads metadata
// from server components); that is fine for a signed-out recovery utility that
// wants no share preview of its own.

// A deliberately loose "does this look like an email" check, matched to the
// browser's own type="email" validation: a single @ with something either
// side and no spaces. Not an RFC-grade validator - verifyOtp is the real
// gate, and this only decides whether to skip the email-entry step.
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value.trim());
}

export default function VerifyPage(props: {
  searchParams: Promise<{ email?: string }>;
}) {
  const searchParams = use(props.searchParams);
  const emailParam =
    typeof searchParams?.email === "string" ? searchParams.email.trim() : "";
  const initialEmail = looksLikeEmail(emailParam) ? emailParam : "";

  // Set once the reader supplies (or arrives with) a usable email; switches
  // this page over to the shared code-entry panel.
  const [email, setEmail] = useState<string | null>(
    initialEmail ? initialEmail : null
  );
  // Only used by the email-entry step below (no ?email= on the URL).
  const [entered, setEntered] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Arrived from sign-in's "email not confirmed" fallback, or with a valid
  // ?email=: render the shared code panel directly. EmailCodeVerify already
  // owns its own full-height <main>, the "we emailed a code to <email>" copy,
  // and the resend button, so we must NOT wrap it in a second <main> here - a
  // nested min-h-screen main was pushing everything to the top instead of
  // centering it. Rendered bare, /verify matches the signup code panel exactly.
  // Default successHref ("/") lets the root page route by role once verifyOtp
  // signs them in; default signInHref ("/signin") is fine since /verify has no
  // ?next= to thread.
  if (email) {
    return <EmailCodeVerify email={email} />;
  }

  // Landed on /verify with no (or a malformed) email: ask for it, then hand off
  // to the same code panel above. Covers someone who bookmarks /verify or types
  // it in directly.
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!looksLikeEmail(entered)) {
      setError("Enter the email address you signed up with.");
      return;
    }
    setError(null);
    setEmail(entered.trim());
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
      <div className="card">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Verify your email
          </h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Enter the email you signed up with and we&apos;ll pick up where you
            left off.
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
              value={entered}
              onChange={(e) => setEntered(e.target.value)}
              autoFocus
              required
            />
          </div>
          <button type="submit" className="btn-primary w-full">
            Continue
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
      </div>
    </main>
  );
}
