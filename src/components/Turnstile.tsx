"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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
