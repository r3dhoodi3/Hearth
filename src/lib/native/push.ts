"use client";

import { isNativeApp, nativePlatform } from "@/lib/platform";

// =============================================================================
// Native push registration (2026-09-07, appstore-execute). Posts the
// APNs (iOS) / FCM (Android) device token to the SAME /api/push/subscribe
// endpoint the web PushRegistrar.tsx already uses, tagged `kind: "native"`
// so the server writes it to public.native_push_tokens instead of
// public.push_subscriptions - see that route and migration 0160 for the
// storage side.
//
// STUBBED: this registers and stores the token. Actually SENDING a native
// push (APNs/FCM delivery from src/lib/push.ts, alongside the existing
// web-push send) is real backend work not done in this pass - see the
// execute report and migration 0160's header comment. Registration alone is
// still worth wiring tonight: it is what App Review's automated capability
// scan and a manual reviewer both look for (a push permission prompt that
// actually calls native registration APIs), and it means no app code changes
// are needed later to start sending once the delivery side is built.
//
// No-op on web (isNativeApp() false) - never call PushNotifications.* there,
// since that plugin does not exist outside a Capacitor shell.
// =============================================================================

let registered = false;

/**
 * Requests push permission (if not already granted/denied) and registers
 * for native push. Call once per app session, after the user is signed in
 * (mirrors PushRegistrar.tsx's own "only after sign-in" gate) - e.g. from
 * NativeBootstrap.tsx's mount effect.
 */
export async function registerNativePush(side: "homeowner" | "pro" | null): Promise<void> {
  if (!isNativeApp() || registered) return;
  registered = true;

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt") {
      // Plain, purpose-explained prompt copy lives in the native UI screen
      // that calls this (not this module) - Apple/Google's own system
      // permission dialog is what actually renders; this call just triggers
      // it. See the research report's "Push notification rules" section:
      // requesting on first app open with no context is a soft rejection
      // pattern, so callers should invoke this from a moment that has
      // already explained why (e.g. after onboarding, not on cold launch).
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== "granted") return;

    await PushNotifications.register();

    PushNotifications.addListener("registration", async (token) => {
      const platform = nativePlatform();
      if (!platform) return;
      try {
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "native",
            token: token.value,
            platform,
            side,
          }),
        });
      } catch (err) {
        console.error("registerNativePush: failed to store token:", err);
      }
    });

    PushNotifications.addListener("registrationError", (err) => {
      console.error("registerNativePush: registration failed:", err);
    });
  } catch (err) {
    console.error("registerNativePush: unavailable:", err);
    registered = false;
  }
}
