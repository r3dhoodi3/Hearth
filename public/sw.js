/* Hearth service worker.
 *
 * TWO JOBS: receive Web Push messages and show them as notifications when the
 * app is closed, and paint a precached warming screen when a full-page
 * navigation stalls on a serverless cold start (the installed PWA reopens at
 * its last URL, and on a cold start that is a blank screen for many seconds).
 * It caches exactly ONE thing, /warming.html, and still never caches real
 * pages or data: an offline mode would mean deciding what a stale dashboard is
 * allowed to show, and a caching service worker that gets it wrong serves
 * yesterday's data forever, which is far worse than a "no connection" page.
 * The fetch handler below never reads the cache for anything but the warming
 * screen, so that failure stays impossible.
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
const VERSION = "hearth-sw-2";

// The one cached asset: the self-contained loading screen served when a
// navigation stalls. It lives in public/ next to this file.
const WARMING_URL = "/warming.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        // { cache: "reload" } goes straight past the HTTP cache, so a stale
        // browser-cached copy of the warming screen can never be installed as
        // the fallback.
        fetch(WARMING_URL, { cache: "reload" }).then((response) => {
          if (response.ok) return cache.put(WARMING_URL, response);
        })
      )
      // A failed precache (offline during install, a 500) must not fail the
      // install: push handling matters more than the fallback, and the fetch
      // handler already copes with a cache miss by using the network as-is.
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        // Caches are named after VERSION, so any other name is a leftover
        // from an earlier worker holding a warming screen nobody serves now.
        Promise.all(
          names.filter((name) => name !== VERSION).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// How long a navigation may hang before the cached warming screen is served
// instead. Tuning: a warm page answers in well under a second, and the cold
// starts this exists for were measured at 6 to 60 seconds, so 3500ms sits far
// from both. In a normal browser tab the old page stays visible while a
// navigation loads, so the fallback only ever replaces a spinner that had
// already run for 3.5 seconds; in the installed app it replaces the blank
// screen that motivated all of this.
const NAVIGATION_TIMEOUT_MS = 3500;

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Deliberately narrow. Each early return leaves the request entirely alone:
  // respondWith is never called, so the browser proceeds exactly as if this
  // handler did not exist.
  //   - Non-GET: form posts and server actions must never be raced against a
  //     timer or answered with a cached page.
  //   - Non-navigations: API calls, scripts, styles, images, and prefetches
  //     have their own loading states; only a full-page navigation can strand
  //     someone on a blank screen.
  //   - Cross-origin: Stripe, Supabase, and everything else external is not
  //     ours to intercept.
  //   - /auth/: those GETs consume one-time codes (the OAuth callback's PKCE
  //     code, the email-confirmation token_hash). The timeout never aborts the
  //     underlying fetch, so the server can consume the code while the client
  //     sees the warming screen, and the screen's retry would then replay a
  //     spent code and strand a signed-in user on a sign-in error. Better a
  //     few blank seconds than a broken sign-in.
  //   - /api/: nothing under /api is a page. Downloads reach here too (a
  //     browser routes an <a download> click through this handler as a
  //     navigation), and hijacking a slow export into the warming screen
  //     would regenerate the export on every retry and never hand the file
  //     over.
  if (request.method !== "GET") return;
  if (request.mode !== "navigate") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/auth/")) return;
  if (url.pathname.startsWith("/api/")) return;

  // Race the real navigation against the timer. Whatever the network answers
  // with, redirects and error statuses included, is returned untouched: the
  // fallback is only for a request that produced NOTHING (still pending at
  // the deadline, or rejected outright because the device is offline). If the
  // warming screen is not cached yet (a first visit before install finished),
  // fall back to the original fetch promise, which is byte for byte what
  // would have happened without this handler. When the timeout wins, the
  // warming screen is served AT the requested URL, so its own reload logic
  // re-requests the real page.
  const networkFetch = fetch(request);
  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const serveWarmingScreen = () => {
        caches.match(WARMING_URL).then(
          (cached) => resolve(cached || networkFetch),
          () => resolve(networkFetch)
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        serveWarmingScreen();
      }, NAVIGATION_TIMEOUT_MS);
      networkFetch.then(
        (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(response);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          serveWarmingScreen();
        }
      );
    })
  );
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
