/* Hearth service worker.
 *
 * ONE JOB ONLY: receive Web Push messages and show them as notifications when
 * the app is closed. It deliberately does NOT cache anything. An offline mode
 * would mean deciding what a stale dashboard is allowed to show, and a caching
 * service worker that gets it wrong serves yesterday's data forever, which is
 * far worse than a "no connection" page. If offline reading is wanted later,
 * it goes in here behind its own fetch handler.
 *
 * Plain JavaScript, no bundler: this file is served verbatim from /sw.js (it
 * lives in public/), so it cannot use TypeScript, imports from src, or any
 * syntax older browsers choke on. Registered by src/components/PushRegistrar.tsx.
 *
 * Bump VERSION on every meaningful change. The browser byte-compares the
 * fetched worker against the installed one and only treats it as an update if
 * something differs, so the constant is what guarantees a change here actually
 * ships. skipWaiting + clients.claim mean the new worker takes over on the next
 * page load instead of waiting for every tab to close.
 */
const VERSION = "hearth-sw-1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// The default shown when a push arrives with a body we cannot read. A push
// event that shows NO notification is a spec violation on some browsers (they
// show a generic "This site has been updated in the background" instead, or
// eventually revoke the permission), so there is always a fallback.
const FALLBACK = {
  title: "Hearth",
  body: "You have a new notification.",
  url: "/dashboard",
  tag: "hearth",
};

function readPayload(event) {
  try {
    if (!event.data) return FALLBACK;
    const raw = event.data.json();
    if (!raw || typeof raw !== "object") return FALLBACK;
    return {
      title: typeof raw.title === "string" && raw.title ? raw.title : FALLBACK.title,
      body: typeof raw.body === "string" ? raw.body : "",
      // Same-origin paths only. The url comes off a push message, and a push
      // service is not a trusted channel: an absolute URL here would let a
      // notification open any site it liked from inside Hearth's own
      // notification. Anything that is not a plain "/path" is replaced.
      url:
        typeof raw.url === "string" &&
        raw.url.startsWith("/") &&
        !raw.url.startsWith("//")
          ? raw.url
          : FALLBACK.url,
      tag: typeof raw.tag === "string" && raw.tag ? raw.tag : FALLBACK.tag,
    };
  } catch {
    // Unreadable payload (not JSON, or a push with no data at all). Show the
    // generic notification rather than nothing: a push event that shows no
    // notification is a spec violation and browsers punish it.
    return FALLBACK;
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // The same tag replaces an earlier notification instead of stacking a
      // second one, so five messages in one thread are one line on the lock
      // screen, not five. Senders pass a per-thread tag (see src/lib/push.ts).
      tag: payload.tag,
      // renotify only matters alongside a tag: it makes a REPLACEMENT buzz the
      // phone again rather than swapping in silently, which is what someone
      // expects from a second message arriving.
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url, version: VERSION },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || FALLBACK.url;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Prefer an app window that is already open: focus it and navigate it,
        // rather than opening a second copy of Hearth beside the one the person
        // already had. navigate() can reject in some browsers (a cross-origin
        // client, an older engine), so it falls back to a plain focus.
        for (const client of clientList) {
          if (typeof client.url !== "string") continue;
          if (new URL(client.url).origin !== self.location.origin) continue;
          return client
            .focus()
            .then((focused) =>
              focused && "navigate" in focused
                ? focused.navigate(target).catch(() => focused)
                : focused
            );
        }
        return self.clients.openWindow(target);
      })
      .catch(() => self.clients.openWindow(target))
  );
});
