// Build-time guard: this module reads VAPID_PRIVATE_KEY and pulls in the
// service-role client, so importing it from a Client Component must fail the
// build, not ship any of that.
import "server-only";
import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import {
  isPushHeldForQuietHours,
  isPushKind,
} from "@/lib/notifyGating";
import {
  deliverPush,
  pushConfigured,
  type PushMessage,
  type StoredPushSubscription,
} from "@/lib/pushDelivery";

// WEB PUSH: the notification that reaches a phone with the app CLOSED.
//
// This is the third channel behind sendNotification (src/lib/notify.ts), after
// email and SMS, and the only one that costs nothing per message - the
// browser's own push service (Apple, Google, Mozilla) does the delivery. That
// is why it is free for everyone on both sides of the marketplace rather than
// a Hearth Plus perk: there is no bill to gate.
//
// HOW THE PIECES FIT:
//   public/sw.js                        the service worker that shows it
//   src/components/PushRegistrar.tsx    registers the worker, keeps the
//                                       subscription fresh
//   src/components/PushSettingsCard.tsx the "Turn on notifications" button
//   src/app/api/push/subscribe          stores/removes a device
//   supabase/migrations/0143_...        public.push_subscriptions
//   src/lib/notifyGating.ts             which kinds earn a buzz, quiet hours
//
// TO ACTIVATE: set three env vars in Vercel (see docs/GO-LIVE-WIRING.md).
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY  public by design, the browser needs it
//   VAPID_PRIVATE_KEY             server-only secret
//   VAPID_SUBJECT                 mailto: contact for the push services
// Generate a pair with `npx web-push generate-vapid-keys`.
//
// Until those exist this module is a no-op with ONE console.warn, exactly like
// the dormant email and SMS channels: nothing throws, nothing breaks, and the
// in-app notification row is written either way.
//
// iPHONE NOTE, because it will come up: Safari only delivers Web Push to a site
// that has been added to the Home Screen (iOS 16.4+). In a Safari TAB there is
// no permission to grant and no subscription to make. Android Chrome has no
// such rule. The UI in PushSettingsCard.tsx explains this rather than showing a
// button that cannot work.

// Fires once per process when the keys are missing, so a busy cron does not
// print this on every single notification. Same pattern as sendEmail's
// sandbox-sender warning in notify.ts.
let warnedMissingKeys = false;

// setVapidDetails is global state on the web-push module, so it is applied
// once per process rather than on every send.
let vapidApplied = false;

function ensureVapid(): boolean {
  if (!pushConfigured(process.env)) {
    if (!warnedMissingKeys) {
      warnedMissingKeys = true;
      console.warn(
        "sendPush: NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / " +
          "VAPID_SUBJECT are not all set, so push notifications are dormant. " +
          "See docs/GO-LIVE-WIRING.md."
      );
    }
    return false;
  }
  if (!vapidApplied) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT!,
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
      );
      vapidApplied = true;
    } catch (e) {
      // A malformed key pair (wrong length, not base64url) throws here rather
      // than at send time. Warn once and stay dormant instead of throwing into
      // whatever server action is waiting on us.
      console.error("sendPush: VAPID keys were rejected:", e);
      return false;
    }
  }
  return true;
}

// The recipient's local hour, for the quiet-hours check. Same single-metro
// hardcoded timezone as sendSms in notify.ts, and the same caveat: a second
// launch metro makes this per-recipient, in both places.
function localHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date())
  );
}

// Push one notification to every device this person has registered.
//
// NEVER THROWS. Every failure path here returns quietly: the in-app
// notification row is already written by the time this runs and is the
// product's authoritative channel, so a push that does not go out costs
// nothing but immediacy. Callers do not need a try/catch.
export async function sendPush(
  userId: string,
  message: PushMessage & { kind?: string }
): Promise<void> {
  try {
    // Allowlist first, before any work: most notification kinds are not push
    // kinds, and this check is free (see PUSH_NOTIFICATION_KINDS).
    if (message.kind !== undefined && !isPushKind(message.kind)) return;
    if (
      message.kind !== undefined &&
      isPushHeldForQuietHours(message.kind, localHour())
    ) {
      return;
    }
    if (!ensureVapid()) return;

    const admin = createAdminClient();

    // Devices first. Almost nobody has any yet, and a person with none is the
    // cheapest possible exit - no preference lookup, no crypto, no network.
    const { data: rows, error } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", userId);
    if (error) {
      // A database that has not run the push migration yet has no such table,
      // which is a "not wired up" state, not an error worth logging on every
      // notification. Anything else really is a fault.
      if (!isMissingSchemaError(error)) {
        console.error(
          "sendPush: push_subscriptions read failed:",
          error.message ?? error
        );
      }
      return;
    }
    const subscriptions = (rows ?? []) as StoredPushSubscription[];
    if (subscriptions.length === 0) return;

    // The opt-out, read only once we know there is somewhere to send. Lives in
    // the SAME users.notification_prefs jsonb as the CAN-SPAM email opt-out, so
    // there is no new column and no new migration for it. Falls OPEN on a read
    // failure, the same way the email opt-out does: the person turned this on
    // themselves with a tap and can turn it off in one, both here and in the
    // browser's own settings.
    try {
      const { data: prefRow } = await admin
        .from("users")
        .select("notification_prefs")
        .eq("id", userId)
        .single();
      if (prefRow?.notification_prefs?.push_opt_out === true) return;
    } catch {
      // Couldn't read prefs; fall open and send. See comment above.
    }

    const { dead } = await deliverPush(subscriptions, message, async (sub, payload) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        );
        return { ok: true };
      } catch (e) {
        // web-push throws a WebPushError carrying the push service's HTTP
        // status. 404/410 means the subscription is gone for good; everything
        // else is transient and the row is kept (see isDeadSubscriptionStatus).
        const status =
          e && typeof e === "object" && "statusCode" in e
            ? Number((e as { statusCode?: unknown }).statusCode)
            : null;
        return { ok: false, status: Number.isFinite(status) ? status : null };
      }
    });

    // Prune the dead endpoints. Without this, an uninstalled app leaves a row
    // that every future notification retries forever.
    if (dead.length > 0) {
      const { error: deleteError } = await admin
        .from("push_subscriptions")
        .delete()
        .in("id", dead);
      if (deleteError) {
        console.error(
          "sendPush: could not delete expired subscriptions:",
          deleteError.message ?? deleteError
        );
      }
    }
  } catch (e) {
    // Absolute backstop. Nothing about a failed push may reach the caller.
    console.error("sendPush: threw:", e);
  }
}
