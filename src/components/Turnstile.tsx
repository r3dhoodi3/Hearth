"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

// Cloudflare Turnstile widget for the auth forms. Renders ONLY when
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is set, so with no key this is a no-op and the
// auth calls send captchaToken: undefined (which Supabase ignores while its own
// Attack Protection CAPTCHA is off). Once the key is set AND Supabase CAPTCHA is
// enabled, the widget produces the token every protected call then requires.
// Tokens are single-use, so callers reset() after each auth attempt.
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
export const CAPTCHA_ENABLED = !!SITE_KEY;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export type TurnstileHandle = { reset: () => void };

// onToken should be a stable setter (e.g. a useState setter passed directly) so
// the render effect below doesn't re-run - and re-mount the widget - on every
// parent render.
const Turnstile = forwardRef<
  TurnstileHandle,
  { onToken: (t: string | null) => void }
>(function Turnstile({ onToken }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    reset() {
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
        onToken(null);
      }
    },
  }));

  useEffect(() => {
    if (!SITE_KEY) return;
    let cancelled = false;
    const render = () => {
      if (
        cancelled ||
        !containerRef.current ||
        !window.turnstile ||
        widgetIdRef.current
      )
        return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
        theme: "auto",
        // Invisible for normal visitors - Turnstile still runs silently and
        // fires `callback` with a token, so the submit gating is unaffected -
        // and only shows a box if Cloudflare decides a real challenge is
        // needed. Keeps the signup form clean while still protecting it.
        appearance: "interaction-only",
      });
    };
    if (window.turnstile) {
      render();
    } else {
      let s = document.querySelector<HTMLScriptElement>(
        'script[src^="https://challenges.cloudflare.com/turnstile"]'
      );
      if (!s) {
        s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
      }
      s.addEventListener("load", render);
    }
    // The script's load event can fire before this listener is attached (cached
    // script, second mount), so also poll until window.turnstile exists.
    const poll = setInterval(() => {
      if (window.turnstile) {
        clearInterval(poll);
        render();
      }
    }, 200);
    return () => {
      cancelled = true;
      clearInterval(poll);
      if (window.turnstile && widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {}
      }
    };
  }, [onToken]);

  if (!SITE_KEY) return null;
  return <div ref={containerRef} className="mt-2 flex justify-center" />;
});

export default Turnstile;

// Every consumer of this widget gates its submit button on
// `CAPTCHA_ENABLED && !captchaToken`, and until now that had no way out if the
// widget itself never called back: no network path from the browser to
// challenges.cloudflare.com (an ad blocker, a captive portal, a CSP that
// blocks it - see next.config.mjs's SCRIPT_SRC, which graduates from
// report-only to enforcing at some point and needs the Turnstile host added
// there for exactly this reason), a Cloudflare-side outage, or the widget's
// own "error-callback" firing (it calls onToken(null), which looks identical
// to "hasn't solved yet" to that same check) all left the button disabled
// forever with no way for a real, human visitor to ever sign in.
//
// This does not weaken the CAPTCHA: it only decides how long a consumer waits
// for a token before giving up and submitting with none, which is the exact
// same request shape every one of these forms already sends when
// NEXT_PUBLIC_TURNSTILE_SITE_KEY isn't set at all (captchaToken: undefined).
// If Supabase's own Attack Protection CAPTCHA is actually on, it rejects that
// request with a normal, retryable error that friendlyAuthError already turns
// into readable copy - the visitor sees a message and can try again, instead
// of staring at a button that will never turn on. If Supabase's CAPTCHA is
// off (as it was as of the 2026-09-04 handoff), the request just succeeds.
// Either way, a client-side widget failure can no longer be the single point
// of failure for signing in.
//
// active: pass false once a token already exists (or before the widget is
// even relevant) so the timer never starts, and true while still waiting.
// Flipping active back to false unmounts the pending timer via the effect's
// own cleanup, same as any other effect-scoped timer.
export function useCaptchaGraceTimeout(active: boolean, ms = 8000): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setTimedOut(true), ms);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return timedOut;
}
