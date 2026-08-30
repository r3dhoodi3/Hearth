// The decision half of Web Push: what a notification looks like on a lock
// screen, and what to do when a subscription comes back dead.
//
// Split out of src/lib/push.ts for exactly the reason src/lib/outboundGuards.ts
// and src/lib/notifyGating.ts were: push.ts carries `import "server-only"` and
// pulls in the service-role client and the VAPID private key, so a test cannot
// import it at all. Everything worth asserting on lives here instead, in a
// dependency-free module with the collaborators injected.

// One stored subscription, as src/lib/push.ts reads it back off
// public.push_subscriptions. Keys are the browser's own: `p256dh` and `auth`
// are what the push service uses to encrypt the payload, and they are useless
// to anyone without the matching private key held by that browser.
export type StoredPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// What a caller wants shown.
export type PushMessage = {
  title: string;
  body?: string | null;
  url?: string | null;
  // Groups related notifications on the device: a second message in the same
  // thread REPLACES the first rather than stacking under it. See public/sw.js.
  tag?: string | null;
};

// Hard ceilings on what goes into the encrypted payload. The Web Push spec
// guarantees only 4KB of payload, and Apple's push service in particular
// rejects anything larger outright, so the two free-text fields are cut here
// rather than at the far end where the failure is a silent non-delivery.
// A lock screen shows roughly this much anyway.
export const PUSH_TITLE_MAX = 120;
export const PUSH_BODY_MAX = 300;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// The exact JSON public/sw.js parses. Kept in one function so the two ends of
// the wire cannot drift.
//
// `url` is normalized to a same-origin path here as well as in the service
// worker. Both ends, on purpose: the worker cannot trust what arrives over the
// push service, and the sender should not be able to produce a message the
// worker will silently rewrite.
export function buildPushPayload(message: PushMessage): string {
  const url =
    typeof message.url === "string" &&
    message.url.startsWith("/") &&
    !message.url.startsWith("//")
      ? message.url
      : "/dashboard";
  return JSON.stringify({
    title: clip(message.title || "Hearth", PUSH_TITLE_MAX),
    body: message.body ? clip(message.body, PUSH_BODY_MAX) : "",
    url,
    tag: message.tag ? clip(message.tag, 60) : "hearth",
  });
}

// The two status codes every push service uses to say "this subscription is
// gone": 404 Not Found and 410 Gone. They mean the browser was uninstalled,
// the site data was cleared, or the person revoked the permission. The row is
// dead and must be deleted, or every future send retries a corpse forever.
//
// Anything else (429 rate limited, 500 from the push service, a network error)
// is transient and the row is KEPT: deleting on a temporary failure would
// silently unsubscribe someone because Google had a bad minute.
export function isDeadSubscriptionStatus(status: number | null | undefined): boolean {
  return status === 404 || status === 410;
}

export type PushDeliveryResult = { sent: number; dead: string[] };

// Fan a single message out to every device this person has registered.
//
// `deliver` is the actual network call (web-push in production, a stub in the
// tests). It must never throw: it reports a failure by returning a status, and
// the loop decides what that status means. `dead` comes back as the list of
// subscription row ids the caller should delete; deleting is the caller's job
// because it needs the database client this module deliberately does not have.
export async function deliverPush(
  subscriptions: readonly StoredPushSubscription[],
  message: PushMessage,
  deliver: (
    subscription: StoredPushSubscription,
    payload: string
  ) => Promise<{ ok: boolean; status?: number | null }>
): Promise<PushDeliveryResult> {
  const payload = buildPushPayload(message);
  const dead: string[] = [];
  let sent = 0;

  // Concurrently: a person with three devices should not wait for three
  // sequential round trips, and one slow push service must not hold up the
  // others. Promise.all is safe here because `deliver` is contracted not to
  // throw and the wrapper below catches anyway.
  await Promise.all(
    subscriptions.map(async (subscription) => {
      let outcome: { ok: boolean; status?: number | null };
      try {
        outcome = await deliver(subscription, payload);
      } catch {
        // A deliverer that threw despite the contract is treated as a
        // transient failure, never as a reason to delete the row.
        outcome = { ok: false, status: null };
      }
      if (outcome.ok) {
        sent += 1;
        return;
      }
      if (isDeadSubscriptionStatus(outcome.status)) dead.push(subscription.id);
    })
  );

  return { sent, dead };
}

// Is Web Push configured for this deployment? Three env vars, all required.
// Written as a pure function over a plain object so the "no keys, no push,
// no crash" behavior is testable without touching process.env.
// Typed as a loose string map rather than a three-key object so `process.env`
// (whose type declares nothing in common with a narrow shape) can be passed
// straight in.
export function pushConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() &&
      env.VAPID_PRIVATE_KEY?.trim() &&
      env.VAPID_SUBJECT?.trim()
  );
}
