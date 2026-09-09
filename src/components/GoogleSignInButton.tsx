"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safeNext";

// Standard four-color Google "G", inline so the button never depends on an
// external asset host (and renders instantly, no network round trip).
function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

// Shared "Continue with Google" button for /signin, /homeowner-signup, and
// /contractor-signup. Starts Supabase's OAuth flow client-side; the browser
// leaves for Google and comes back on /auth/callback?code=..., which
// exchanges the code for a session and follows `next` the same way the
// email/password flows already do (see src/app/auth/callback/route.ts).
//
// Same button for sign-in and sign-up: Google OAuth doesn't distinguish the
// two, Supabase auto-provisions a new auth.users row on first callback the
// same as it would for a brand new email/password account.
export default function GoogleSignInButton({
  next,
  onError,
}: {
  // Where /auth/callback should send the browser after the exchange. Same
  // relative-path contract as every other ?next= in this app; re-validated
  // here via safeNextPath since a prop can come from any future caller, not
  // just the trusted pages that use it today.
  next: string | null;
  // Each page already renders its own inline error UI for the
  // email/password form; reusing that instead of adding a second, visually
  // inconsistent error surface just for this button.
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const supabase = createClient();

  async function onClick() {
    setBusy(true);
    const safePath = safeNextPath(next);
    const redirectTo = `${window.location.origin}/auth/callback${
      safePath ? `?next=${encodeURIComponent(safePath)}` : ""
    }`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        // Always show Google's account chooser. Without this, a browser signed
        // into a single Google account that already authorized OakTend gets
        // silently logged straight in with no chance to pick a different
        // account.
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setBusy(false);
      onError(error.message);
      return;
    }
    // Success: signInWithOAuth navigates the browser away to Google itself.
    // Stay disabled until that navigation happens so a second click can't
    // fire a duplicate request.
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="btn-secondary w-full"
    >
      <GoogleLogo />
      {busy ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}
