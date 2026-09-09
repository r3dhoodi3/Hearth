"use client";

import { isNativeApp } from "@/lib/platform";

// =============================================================================
// Tiny haptics helper (2026-09-07, appstore-execute). Guideline 4.2's
// "elevate it beyond a repackaged website" checklist explicitly calls out
// haptics as cheap credibility - real native apps give tactile feedback on
// primary actions, a plain website cannot. No-op on web (isNativeApp() is
// false there), so every call site stays safe to leave in place unconditionally.
//
// Use tap() on the main CTA of a screen (a submit button, "Start Plus", "Send
// message", "Apply to job") - not on every click in the app, which would
// just be buzzy rather than purposeful. success()/warn() are for a result,
// not an intent.
// =============================================================================

let hapticsModulePromise: Promise<typeof import("@capacitor/haptics")> | null = null;
function loadHaptics() {
  if (!hapticsModulePromise) hapticsModulePromise = import("@capacitor/haptics");
  return hapticsModulePromise;
}

async function safe(fn: () => Promise<void>): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await fn();
  } catch {
    // Haptics are pure decoration; a plugin/platform hiccup should never
    // surface to the user or interrupt whatever action triggered it.
  }
}

/** Light tap feedback for a primary button press. */
export function tap(): void {
  void safe(async () => {
    const { Haptics, ImpactStyle } = await loadHaptics();
    await Haptics.impact({ style: ImpactStyle.Light });
  });
}

/** Feedback for a completed, successful action (e.g. payment/purchase done). */
export function success(): void {
  void safe(async () => {
    const { Haptics, NotificationType } = await loadHaptics();
    await Haptics.notification({ type: NotificationType.Success });
  });
}

/** Feedback for a failed/blocked action. */
export function warn(): void {
  void safe(async () => {
    const { Haptics, NotificationType } = await loadHaptics();
    await Haptics.notification({ type: NotificationType.Warning });
  });
}
