"use client";

import { NATIVE_CLIENT_HEADER, nativeClientHeaderValue } from "@/lib/platform";

// =============================================================================
// Installs the X-OakTend-Client header (src/lib/platform.ts) onto every
// same-origin fetch the app makes, so the server-side gate in
// src/lib/nativeClientHeader.ts can tell a native request from a web one.
// Call installNativeFetchHeader() exactly once, as early as possible, from
// src/lib/native/bootstrap.ts (which itself only runs when isNativeApp() is
// true - see that file).
//
// SAME-ORIGIN ONLY, on purpose: stamping this header onto a cross-origin
// request (Supabase's own REST/Realtime endpoints, Stripe.js, Anthropic, any
// third party) would leak "this is the OakTend native app" to services that
// have no reason to know or care, and some of them CORS-reject unrecognized
// request headers outright, which would break auth/data calls that have
// nothing to do with the Stripe-vs-IAP gate this header exists for.
// =============================================================================

let installed = false;

export function installNativeFetchHeader(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  const headerValue = nativeClientHeaderValue();
  if (!headerValue) return; // web: nothing to install
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url =
        typeof input === "string" || input instanceof URL
          ? new URL(input, window.location.origin)
          : new URL(input.url, window.location.origin);
      if (url.origin === window.location.origin) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        // NATIVE_CLIENT_HEADER, never a re-typed literal: the server reads the
        // same constant (src/lib/nativeClientHeader.ts), and a spelling drift
        // between the two would silently disable the Stripe-vs-IAP gate rather
        // than fail loudly.
        headers.set(NATIVE_CLIENT_HEADER, headerValue);
        return originalFetch(input, { ...init, headers });
      }
    } catch {
      // Malformed URL or anything else unexpected: fall through and issue
      // the original, unmodified request rather than breaking the call.
    }
    return originalFetch(input, init);
  };
}
