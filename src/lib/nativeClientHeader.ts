import "server-only";
import { headers } from "next/headers";
import { NATIVE_CLIENT_HEADER } from "@/lib/nativeHeaderName";

// =============================================================================
// Server-side twin of src/lib/platform.ts's isNativeApp(). THIS is the actual
// enforcement point for "no Stripe checkout for OakTend Plus/Pro on native" -
// a client-side Capacitor.isNativePlatform() check alone can be spoofed (a
// modified build, a browser dev console pretending to be native), so the
// homeowner and pro Plus checkout server actions call isNativeClientRequest()
// here and refuse before ever calling Stripe, rather than trusting whichever
// button the client happened to render.
//
// The header itself is set by src/lib/nativeFetch.ts's fetch wrapper, which
// every request the native app shell makes should route through (wired at
// native boot - see src/lib/native/bootstrap.ts). A plain browser request
// never sends this header, so isNativeClientRequest() is false for every real
// web visitor by construction, not by an allowlist that could drift.
//
// WHAT THIS DOES NOT GATE: lead-fee checkout (src/app/api/... lead apply/pay
// flows) and wallet deposits (src/app/pro/billing/actions.ts) stay open on
// native. Per the App Store research (section 1, 3.1.3(e)), those purchase
// access to a real-world job performed outside the app, not a digital unlock,
// so Stripe is the correct rail on every platform for those two flows -
// nothing in this module is called from them.
// =============================================================================

export type NativeClient = "ios-app" | "android-app";

/** The raw header value, or null if this request did not send it (web). */
export async function nativeClientHeader(): Promise<NativeClient | null> {
  try {
    const h = await headers();
    const value = h.get(NATIVE_CLIENT_HEADER);
    return value === "ios-app" || value === "android-app" ? value : null;
  } catch {
    // headers() throws outside a request context (rare - e.g. some test
    // harnesses). Fail to "not native": the only consequence is Stripe
    // checkout staying open, which is the SAFE direction for a check whose
    // sole job is to refuse an in-app purchase path Apple/Google forbid -
    // never silently blocking a real web checkout because of a plumbing
    // error is the more important failure mode to avoid here.
    return null;
  }
}

/** True when this request came from the native iOS or Android app shell. */
export async function isNativeClientRequest(): Promise<boolean> {
  return (await nativeClientHeader()) !== null;
}

/** The plain-language refusal shown when a native client hits a Stripe-only checkout path. */
export const NATIVE_STRIPE_BLOCKED_MESSAGE =
  "Subscriptions in the app go through the App Store.";
