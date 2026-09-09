"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safeNext";
import { APPLE_SIGN_IN_ENABLED } from "@/lib/constants";
import { isNativeApp } from "@/lib/platform";

// The standard Apple mark, inline so the button never depends on an external
// asset host (and renders instantly, no network round trip). fill is
// currentColor rather than a fixed black: the button is btn-secondary, which
// flips its text color in dark mode, and a hard-coded black glyph would
// disappear against the dark surface.
function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.635 0 2.98.06 4.53 2.26-.137.08-2.62 1.53-2.62 4.56 0 3.6 3.098 4.87 3.098 4.93z"
      />
    </svg>
  );
}

// Shared "Continue with Apple" button for /signin, /homeowner-signup, and
// /contractor-signup - the exact twin of GoogleSignInButton, sitting right
// under it. Starts Supabase's OAuth flow client-side; the browser leaves for
// Apple and comes back on /auth/callback?code=..., which exchanges the code
// for a session and follows `next` the same way the email/password flows
// already do (see src/app/auth/callback/route.ts - nothing in that route is
// provider-specific, so Apple needs no changes there).
//
// Same button for sign-in and sign-up: Apple's OAuth doesn't distinguish the
// two, and Supabase auto-provisions a new auth.users row on first callback
// the same as it would for a brand new email/password account.
//
// One thing Apple does differently from Google, worth knowing before anyone
// debugs a missing name: Apple returns the user's name and email ONLY on the
// very FIRST authorization of this app by that Apple ID. Every later sign-in
// returns the identity token alone. So a user who authorizes, gets deleted
// from our database, and comes back arrives with no name attached - and there
// is no way to ask Apple for it again short of the user revoking OakTend under
// Settings > Apple ID > Sign in with Apple. Supabase handles the token
// exchange and stores whatever Apple did send, so nothing here needs to
// special-case it; the callback's full_name backfill simply has nothing to
// copy for those users, exactly like any other account missing a name, and
// onboarding asks for it directly. Users who pick "Hide My Email" arrive with
// a privaterelay.appleid.com address. Those ARE real inboxes, but Apple only
// relays mail from senders registered under "Sign in with Apple for Email
// Communication" in the developer console (with SPF/DKIM passing); anything
// else bounces with 550 5.1.1. Registering OakTend's sending domain is part of
// docs/APPLE-SIGN-IN-SETUP.md, step 6.
//
// No queryParams here on purpose. Google's `prompt: "select_account"` is a
// Google-ism; Apple ignores it, and the equivalent forced re-prompt is not
// something Apple exposes to web clients.

// Whether to render the button at all. Apple's provider needs a Services ID,
// a signing key, and a six-month JWT pasted into Supabase before it works
// (docs/APPLE-SIGN-IN-SETUP.md); until that is done, clicking the button only
// ever produces a "provider is not enabled" error, which is a broken-looking
// front door on the three most important pages in the app. So the button is
// off by default and turns on with NEXT_PUBLIC_APPLE_SIGNIN=1, set in Vercel
// once the provider is live.
//
// Also gated on APPLE_SIGN_IN_ENABLED (src/lib/constants.ts) - a second,
// independent switch for a product decision rather than a technical one:
// as of 2026-08-28 the owner wants Apple hidden everywhere so a fresh account
// can be created and onboarding seen without hitting the button, regardless
// of whether the Supabase provider itself is configured. Both switches must
// be on for the button to render; folding the check in here, rather than in
// each of the three pages that import APPLE_SIGNIN_ENABLED, keeps a single
// source of truth so the button and its "By continuing with Google or Apple"
// consent copy never disagree.
//
// Exported so the sign-up pages can match their "By continuing with Google or
// Apple" consent copy to what is actually on screen. The literal
// process.env.NEXT_PUBLIC_* read is required for Next to inline the value
// into the client bundle at build time.
export const APPLE_SIGNIN_ENABLED =
  process.env.NEXT_PUBLIC_APPLE_SIGNIN === "1" && APPLE_SIGN_IN_ENABLED;

type AppleSignInButtonProps = {
  // Where /auth/callback should send the browser after the exchange. Same
  // relative-path contract as every other ?next= in this app; re-validated
  // here via safeNextPath since a prop can come from any future caller, not
  // just the trusted pages that use it today.
  next: string | null;
  // Each page already renders its own inline error UI for the
  // email/password form; reusing that instead of adding a second, visually
  // inconsistent error surface just for this button. Until the Apple provider
  // is actually enabled in the Supabase dashboard (see
  // docs/APPLE-SIGN-IN-SETUP.md), signInWithOAuth returns a
  // provider-not-enabled error instead of navigating, and it lands here - a
  // readable message in the page's normal error box, no crash, no dead tab.
  onError: (message: string) => void;
};

// Gate kept separate from the body so the body's hooks are never called
// conditionally.
export default function AppleSignInButton(props: AppleSignInButtonProps) {
  if (!APPLE_SIGNIN_ENABLED) return null;
  return <AppleSignInButtonBody {...props} />;
}

function AppleSignInButtonBody({ next, onError }: AppleSignInButtonProps) {
  const [busy, setBusy] = useState(false);
  const supabase = createClient();

  // NATIVE PATH (2026-09-07, appstore-execute): inside the Capacitor app
  // shell, Apple's own AuthenticationServices framework runs the sign-in
  // natively (no WKWebView OAuth redirect dance, no oaktend://auth/callback
  // round trip) via @capacitor-community/apple-sign-in, which returns a
  // signed identityToken straight from Apple. That token is handed to
  // Supabase's signInWithIdToken, which verifies it against Apple's public
  // keys and creates/loads the session exactly like the web OAuth flow does
  // - same auth.users row, same public.users backfill, same `next` handling.
  // The WEB PATH below (signInWithOAuth) is completely untouched: this
  // native branch is chosen BEFORE anything web-specific runs.
  async function onClickNative() {
    setBusy(true);
    try {
      const { SignInWithApple } = await import(
        "@capacitor-community/apple-sign-in"
      );
      const clientId = process.env.NEXT_PUBLIC_APPLE_SERVICES_ID;
      if (!clientId) {
        setBusy(false);
        onError(
          "Sign in with Apple is not configured for this build yet (missing NEXT_PUBLIC_APPLE_SERVICES_ID)."
        );
        return;
      }
      // NONCE: Apple and Supabase want the two HALVES of one value, not the
      // same string twice. Apple embeds whatever is handed to
      // ASAuthorizationAppleIDRequest.nonce into the identity token VERBATIM
      // (the plugin sets `request.nonce = call.getString("nonce")` with no
      // hashing of its own - checked in its Plugin.swift), while Supabase's
      // signInWithIdToken SHA-256-hashes the nonce it is given and compares
      // that hash to the token's claim. So Apple must receive the HASH and
      // Supabase the RAW value; sending the raw value to both fails every
      // sign-in with a nonce mismatch.
      const nonce = crypto.randomUUID();
      const hashedNonce = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce))
        )
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const result = await SignInWithApple.authorize({
        clientId,
        // Required by the plugin's Android path (a WebView-based OAuth
        // fallback there, since Android has no native AuthenticationServices
        // equivalent); ignored by iOS's native ASAuthorizationController
        // flow. Points at the same callback the web flow already uses.
        redirectURI: `${window.location.origin}/auth/callback`,
        scopes: "email name",
        nonce: hashedNonce,
      });
      const identityToken = result.response.identityToken;
      const { error } = await supabase.auth.signInWithIdToken({
        provider: "apple",
        token: identityToken,
        nonce,
      });
      if (error) {
        setBusy(false);
        onError(error.message);
        return;
      }
      const safePath = safeNextPath(next);
      window.location.href = safePath || "/dashboard";
    } catch (err: any) {
      setBusy(false);
      // The plugin rejects with an error code (e.g. "1001") when the user
      // cancels the native sheet - not a real failure, so nothing is shown.
      if (err?.message && /cancel/i.test(String(err.message))) return;
      onError("Couldn't sign in with Apple just now. Please try again.");
    }
  }

  async function onClick() {
    if (isNativeApp()) return onClickNative();

    setBusy(true);
    const safePath = safeNextPath(next);
    const redirectTo = `${window.location.origin}/auth/callback${
      safePath ? `?next=${encodeURIComponent(safePath)}` : ""
    }`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "apple",
      options: { redirectTo },
    });
    if (error) {
      setBusy(false);
      onError(error.message);
      return;
    }
    // Success: signInWithOAuth navigates the browser away to Apple itself.
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
      <AppleLogo />
      {busy ? "Redirecting…" : "Continue with Apple"}
    </button>
  );
}
