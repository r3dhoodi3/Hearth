// Browser half of Web Push: register the service worker, ask for permission,
// hand the resulting subscription to the server.
//
// Every function here is defensive to the point of paranoia, because this code
// runs across four very different engines with four different sets of missing
// APIs (iOS Safari only has any of this once the app is on the Home Screen),
// and a thrown error inside the signed-in shell is a blank page. Nothing here
// throws: each call reports what happened and the UI explains it.
//
// Server half: src/app/api/push/subscribe (storage) and src/lib/push.ts
// (sending). The worker itself is public/sw.js.

import { needsHomeScreenInstallForPush } from "@/lib/installState";

export const SERVICE_WORKER_URL = "/sw.js";
export const SUBSCRIBE_ENDPOINT = "/api/push/subscribe";

export type PushSide = "homeowner" | "pro";

// What a "Turn on notifications" tap can end in. Each maps to one line of copy
// in src/components/PushSettingsCard.tsx.
export type PushEnableResult =
  | "granted"
  | "denied"
  // Dismissed the browser prompt without choosing. Ask again another day.
  | "dismissed"
  // iPhone in a Safari tab: there is nothing to ask for until Hearth is on the
  // Home Screen.
  | "needs-install"
  // No service worker or no PushManager at all (an old browser, a private
  // window on some engines).
  | "unsupported"
  // Permission was granted but the subscribe or the save failed.
  | "failed";

// Public VAPID key, inlined at build time by Next because of the NEXT_PUBLIC_
// prefix. Public by design: the browser has to send it to its push service to
// create a subscription. Empty when the deployment has not been given keys, in
// which case the whole feature stays hidden rather than showing a button that
// cannot work.
export function vapidPublicKey(): string {
  return (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "").trim();
}

// Does this browser have service workers at all? Wider than pushSupported():
// the worker now also serves the cold-start warming screen (public/sw.js), so
// it is worth registering on a browser that has service workers but no push.
export function serviceWorkerSupported(): boolean {
  try {
    return typeof window !== "undefined" && "serviceWorker" in navigator;
  } catch {
    return false;
  }
}

// Does this browser have the three APIs the feature needs?
export function pushSupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  } catch {
    return false;
  }
}

// "default" (never asked), "granted", or "denied". "unavailable" when the API
// is not there at all, which keeps callers from having to null-check.
export function pushPermission(): NotificationPermission | "unavailable" {
  try {
    if (typeof Notification === "undefined") return "unavailable";
    return Notification.permission;
  } catch {
    return "unavailable";
  }
}

// The applicationServerKey a PushManager wants is raw bytes, while a VAPID
// public key is distributed as base64url text. This is the standard conversion,
// padding the base64 back out and swapping the URL-safe characters.
// Returns ArrayBuffer rather than Uint8Array: applicationServerKey is typed as
// BufferSource over a plain ArrayBuffer, and a Uint8Array's buffer is the wider
// ArrayBufferLike (it could be a SharedArrayBuffer), which TypeScript refuses.
// The bytes are identical either way.
function urlBase64ToBytes(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

// Register (or find the existing registration for) /sw.js. Returns null rather
// than throwing when service workers are unavailable or the registration is
// refused, which happens in private windows and on insecure origins. Gated on
// serviceWorkerSupported() rather than pushSupported(): registration is what
// installs the cold-start warming screen, and that has no push prerequisites.
// Every push caller (enablePush, refreshPushSubscription) still checks
// pushSupported() itself before subscribing.
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch {
    return null;
  }
}

// The shape /api/push/subscribe expects. PushSubscription.toJSON() already
// produces exactly this, but it is spelled out so a browser with a partial
// implementation cannot post something the route will reject.
type SubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  side?: PushSide;
};

function toPayload(
  subscription: PushSubscription,
  side?: PushSide
): SubscriptionPayload | null {
  try {
    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
    return {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      ...(side ? { side } : {}),
    };
  } catch {
    return null;
  }
}

async function saveSubscription(payload: SubscriptionPayload): Promise<boolean> {
  try {
    const response = await fetch(SUBSCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Ask for permission and subscribe. MUST BE CALLED FROM A TAP HANDLER: every
// browser requires a user gesture for Notification.requestPermission(), and a
// call made from an effect is either ignored outright or counted as a denial
// the person never made.
export async function enablePush(side?: PushSide): Promise<PushEnableResult> {
  if (!pushSupported()) {
    // On an iPhone this is the normal state in a Safari tab: none of the APIs
    // exist until Hearth is on the Home Screen. Report that, not "unsupported",
    // because it is fixable in about fifteen seconds.
    return needsHomeScreenInstallForPush() ? "needs-install" : "unsupported";
  }
  if (needsHomeScreenInstallForPush()) return "needs-install";
  if (!vapidPublicKey()) return "unsupported";

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return "failed";
  }
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "dismissed";

  const registration = await registerServiceWorker();
  if (!registration) return "failed";

  try {
    // `ready` rather than using the registration straight away: a worker that
    // has just been registered is not yet active, and subscribing against an
    // inactive registration fails on some engines.
    const active = await navigator.serviceWorker.ready;
    const subscription =
      (await active.pushManager.getSubscription()) ??
      (await active.pushManager.subscribe({
        // Required by every browser now, and true is the only value they
        // accept: it promises that every push produces a visible notification,
        // which public/sw.js guarantees with its fallback payload.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(vapidPublicKey()),
      }));
    const payload = toPayload(subscription, side);
    if (!payload) return "failed";
    return (await saveSubscription(payload)) ? "granted" : "failed";
  } catch {
    return "failed";
  }
}

// Called on every visit once permission is already granted, so a reinstall, a
// cleared site data, or a rotated VAPID key heals itself instead of leaving
// somebody with notifications that silently stopped. Silent: no permission
// prompt can appear from here, because permission is already granted.
export async function refreshPushSubscription(side?: PushSide): Promise<boolean> {
  if (!pushSupported()) return false;
  if (pushPermission() !== "granted") return false;
  if (!vapidPublicKey()) return false;

  try {
    const active = await navigator.serviceWorker.ready;
    const existing = await active.pushManager.getSubscription();
    const subscription =
      existing ??
      (await active.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(vapidPublicKey()),
      }));
    const payload = toPayload(subscription, side);
    if (!payload) return false;
    return await saveSubscription(payload);
  } catch {
    return false;
  }
}

// Turn it off for THIS device: drop the browser subscription and tell the
// server to forget the row. The browser permission itself is not ours to
// revoke - only the person can, in their browser settings - so the copy in the
// settings card says so.
export async function disablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const active = await navigator.serviceWorker.ready;
    const subscription = await active.pushManager.getSubscription();
    if (!subscription) return true;
    const endpoint = subscription.endpoint;
    // Unsubscribe first: if the server call fails afterwards the worst outcome
    // is a stale row that the next send prunes on its 410 (see
    // isDeadSubscriptionStatus in src/lib/pushDelivery.ts). The other order
    // would leave a live subscription with no row, which nothing ever cleans.
    await subscription.unsubscribe().catch(() => {});
    const response = await fetch(SUBSCRIBE_ENDPOINT, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Is this device currently subscribed? Used by the settings card so it can show
// "on" for a device that has already been through the flow.
export async function hasPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  if (pushPermission() !== "granted") return false;
  try {
    const active = await navigator.serviceWorker.ready;
    return (await active.pushManager.getSubscription()) != null;
  } catch {
    return false;
  }
}
