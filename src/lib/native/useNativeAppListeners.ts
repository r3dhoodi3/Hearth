"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isNativeApp } from "@/lib/platform";

// =============================================================================
// Native app lifecycle listeners (2026-09-07, appstore-execute). Guideline
// 4.2 wants real native navigation, not "a repackaged website" - deep links
// opening inside the app, the Android hardware back button behaving like a
// native back stack, and content refreshing when the app comes back to the
// foreground are the concrete signals reviewers look for.
//
// No-op on web: every listener registration below is skipped when
// isNativeApp() is false, so this hook is safe to mount unconditionally from
// a client component near the root of the app (wired into NativeBootstrap.tsx,
// itself mounted once in the root layout).
// =============================================================================
export function useNativeAppListeners(): void {
  const router = useRouter();

  useEffect(() => {
    if (!isNativeApp()) return;

    let cancelled = false;
    const handles: Array<{ remove: () => void }> = [];

    (async () => {
      const { App } = await import("@capacitor/app");
      if (cancelled) return;

      // Deep links: a push notification tap, a shared job/report link, or the
      // oaktend:// OAuth callback opens the app instead of the OS's default
      // browser handling - route it through Next's client router rather than
      // a full page reload, same as clicking a normal <Link>. Universal Links
      // (apple-app-site-association) and the oaktend:// custom scheme both
      // arrive through this one event.
      handles.push(
        await App.addListener("appUrlOpen", (event) => {
          try {
            const url = new URL(event.url);
            // Same-origin (oaktend.com) or the custom oaktend:// scheme: take
            // just the path+query+hash and hand it to the in-app router. A
            // link to some other host (should not happen, but a
            // maliciously-crafted deep link is not impossible) is ignored
            // rather than navigated to.
            const isOwnScheme = url.protocol === "oaktend:";
            const isOwnHost =
              url.hostname === "oaktend.com" ||
              url.hostname.endsWith(".oaktend.com") ||
              url.hostname === window.location.hostname;
            if (!isOwnScheme && !isOwnHost) return;
            // OPEN-REDIRECT GUARD. Taking only pathname+search+hash is not
            // enough on its own: for a non-special scheme, "oaktend://x//evil.com/p"
            // parses to hostname "x" and pathname "//evil.com/p", and
            // router.push("//evil.com/p") is a PROTOCOL-RELATIVE url that
            // navigates the WebView clean off oaktend.com. Anything that is not
            // a single-slash absolute path is refused outright rather than
            // rewritten, so a crafted deep link can only ever land on a real
            // in-app route.
            //
            // A BACKSLASH IS A SLASH once the path is resolved against an
            // https document, which is the hole the "//" test alone left open
            // (red team, 2026-09-08): "oaktend://x/\evil.com" parses to
            // pathname "/\evil.com", which passes a startsWith("//") test, but
            // the WHATWG URL parser treats "\" as "/" for special schemes, so
            // new URL("/\\evil.com", "https://oaktend.com") is
            // "https://evil.com/" - the router would have navigated the
            // WebView straight off the app, inside the app's own chrome, which
            // is a ready-made phishing screen. Refuse any backslash outright
            // rather than rewriting it: no real in-app route has one.
            const rawPath = url.pathname || "/";
            if (
              !rawPath.startsWith("/") ||
              rawPath.startsWith("//") ||
              rawPath.includes("\\")
            )
              return;
            router.push(`${rawPath}${url.search}${url.hash}`);
          } catch {
            // Malformed URL: nothing safe to do with it.
          }
        })
      );

      // Android hardware back button: at the root of the nav stack, exit the
      // app (the OS default); anywhere else, go back one step in-app instead
      // of the WebView's own history, which can leave a signed-in user
      // staring at a blank about:blank page. iOS has no hardware back button,
      // so this listener is inert there but harmless to register.
      handles.push(
        await App.addListener("backButton", ({ canGoBack }) => {
          if (canGoBack) {
            router.back();
          } else {
            App.exitApp();
          }
        })
      );

      // Resume (app brought back to the foreground after being backgrounded):
      // refetch whatever the current screen shows, the same "came back to the
      // tab" refresh the web app already does via visibilitychange in a few
      // places (e.g. LeadChat.tsx) - router.refresh() re-runs the current
      // route's server data without a full reload or losing client state.
      handles.push(
        await App.addListener("resume", () => {
          router.refresh();
        })
      );
    })();

    return () => {
      cancelled = true;
      for (const h of handles) h.remove();
    };
    // router is stable across renders (Next's useRouter identity), so this
    // effect intentionally runs once on mount, matching the "register once,
    // clean up on unmount" shape every other global listener in this app uses
    // (see StaleDeployRecovery.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
