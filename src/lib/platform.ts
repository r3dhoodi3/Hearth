"use client";

// =============================================================================
// Native-app platform gate (2026-09-07, appstore-execute).
//
// The single source of truth for "is this code running inside the OakTend
// iOS/Android app shell (Capacitor), or in a regular web browser (including
// installed-as-PWA)". Two things read this:
//   1. Client components that need to render different UI on native (e.g. the
//      Plus/Pro paywall showing a RevenueCat button instead of a Stripe one).
//   2. src/lib/nativeFetch.ts, which stamps every outgoing request with the
//      X-OakTend-Client header the SERVER actually trusts (see below) - this
//      module's isNativeApp() alone is a client-side UI hint only and must
//      never be trusted for a security or billing decision, since any client
//      check can be spoofed by a modified build or a browser dev console.
//
// SERVER-SIDE ENFORCEMENT LIVES ELSEWHERE. The homeowner/pro Plus Stripe
// checkout server actions (src/app/(app)/plus/actions.ts,
// src/app/pro/plus/actions.ts) read the X-OakTend-Client request header via
// next/headers and refuse when it says ios-app/android-app - see
// isNativeClientRequest() in src/lib/nativeClientHeader.ts, the server-side
// twin of this file. That header is set by nativeFetch's fetch wrapper below,
// which every native build's requests should route through (wired at native
// app boot in src/lib/native/bootstrap.ts).
// =============================================================================

// process.env.NEXT_PUBLIC_* is what makes NEXT_PUBLIC_SITE_URL etc. available
// client-side; @capacitor/core's Capacitor.isNativePlatform() is the real
// signal (it checks for the injected Capacitor bridge object, which only
// exists inside a Capacitor WebView), imported lazily so a plain web bundle
// never has to ship the Capacitor runtime it will never use.
let cachedIsNative: boolean | null = null;

/**
 * True only inside the Capacitor iOS/Android app shell. False on the server
 * (SSR/RSC render), false in a regular browser tab, and false in an
 * installed-as-PWA context (PWA install is a browser feature, not a
 * Capacitor one - it has no bridge object either).
 *
 * Safe to call from any Client Component; never throws. Client-side UI hint
 * only - see the module comment above for why this is not a security
 * boundary.
 */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false; // SSR/RSC: never native
  if (cachedIsNative !== null) return cachedIsNative;
  try {
    // Capacitor's global bridge object. Checking for its presence rather
    // than importing @capacitor/core's Capacitor.isNativePlatform() directly
    // at module scope keeps this file import-safe even in a test/JSDOM
    // environment that never loaded the Capacitor runtime.
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    cachedIsNative = typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
  } catch {
    cachedIsNative = false;
  }
  return cachedIsNative;
}

/** 'ios' | 'android' | null (web, or platform not yet determinable). */
export function nativePlatform(): "ios" | "android" | null {
  if (typeof window === "undefined") return null;
  try {
    const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const p = cap?.getPlatform?.();
    return p === "ios" || p === "android" ? p : null;
  } catch {
    return null;
  }
}

// The exact header name the server checks (src/lib/nativeClientHeader.ts).
// Kept as one exported constant so the client stamp and the server read can
// never spell it differently. It now LIVES in src/lib/nativeHeaderName.ts,
// which carries no "use client" directive: a plain value exported from a
// "use client" module reads as `undefined` on the server, which is what made
// the server-side gate a silent no-op until 2026-09-08 (see that file's
// header comment). Re-exported here so every existing client import keeps
// working unchanged.
export { NATIVE_CLIENT_HEADER } from "@/lib/nativeHeaderName";

/** The header value a native build sends, or null on web (no header sent). */
export function nativeClientHeaderValue(): "ios-app" | "android-app" | null {
  const platform = nativePlatform();
  if (platform === "ios") return "ios-app";
  if (platform === "android") return "android-app";
  return null;
}
