import type { CapacitorConfig } from "@capacitor/cli";

// =============================================================================
// OakTend Capacitor config, App Store scaffold (2026-09-07, appstore-execute).
//
// REMOTE-URL PATTERN, NOT A STATIC BUNDLE. OakTend is a server-rendered
// Next.js 15 App Router app: server actions, dynamic routes, cookies-based
// auth. None of that can be statically exported into a webDir the way most
// Capacitor tutorials assume. So this config points server.url at the live
// site instead of bundling HTML/JS: the native shell is a thin WKWebView
// (iOS) / WebView (Android) wrapper that LOADS oaktend.com over HTTPS, the
// same as a browser tab, except with native plugin bridges (camera, push,
// IAP, haptics, etc.) available to the page's JS via the Capacitor runtime
// injected into that WebView.
//
// webDir still has to point at a real folder (Capacitor's CLI requires it to
// exist), so it points at public/native-loader - a tiny static HTML page that
// immediately redirects to the real server.url. That folder is ONLY ever
// shown for a split second before Capacitor's native shell finishes loading
// the remote URL, or as a fallback if the remote load fails outright (e.g. no
// network on first launch before the Network plugin's offline screen mounts).
//
// appId is a PLACEHOLDER (com.oaktend.app) until Landen confirms the real
// bundle id in Apple Developer / Google Play Console. Changing it after
// `cap add ios`/`cap add android` requires re-running those (or manually
// renaming the Xcode/Gradle project identifiers) - flagged in
// docs/APP-STORE-SUBMISSION.md.
// =============================================================================
const config: CapacitorConfig = {
  appId: "com.oaktend.app", // TODO(appstore): confirm real bundle id with Landen before submission
  appName: "OakTend",
  webDir: "public/native-loader",
  server: {
    // CAPACITOR_SERVER_URL lets a local/staging build point at something
    // other than production (e.g. an ngrok tunnel to a dev server) without
    // editing this file. Falls back to the live site.
    url: process.env.CAPACITOR_SERVER_URL || "https://oaktend.com",
    // https on both platforms: the app never renders content over plain
    // http, and this keeps cookie/secure-context behavior identical to the
    // web app's own production deploy.
    iosScheme: "https",
    androidScheme: "https",
    // Every host the WebView is allowed to NAVIGATE to (not just fetch from
    // - fetch/XHR calls are unaffected by this list). oaktend.com is the app
    // itself; *.supabase.co is Supabase Auth's OAuth/session endpoints;
    // appleid.apple.com and accounts.google.com are the two OAuth providers'
    // consent screens. checkout.stripe.com is DELIBERATELY NOT on this list:
    // subscriptions must never route through Stripe checkout on native (Apple
    // 3.1.1 - IAP only), and omitting the host means a native build cannot
    // even navigate there if server-side gating in src/lib/platform.ts / the
    // Plus checkout actions were ever bypassed client-side. Lead-fee and
    // wallet-deposit Stripe flows stay Stripe-only per the App Store
    // research's 3.1.3(e) reasoning (physical-service access, not a digital
    // unlock) - those still work on native because the SERVER never refuses
    // them, but they don't need a WebView navigation to checkout.stripe.com
    // either: Stripe Checkout Sessions open in @capacitor/browser's in-app
    // browser (SFSafariViewController/Custom Tabs), which is a separate
    // native surface, not a navigation inside this WebView.
    allowNavigation: [
      "oaktend.com",
      "*.oaktend.com",
      "*.supabase.co",
      "appleid.apple.com",
      "accounts.google.com",
    ],
  },
  ios: {
    // Matches the manifest's background_color (src/app/manifest.ts) so the
    // native splash/status-bar frame never flashes a mismatched white before
    // the page paints.
    backgroundColor: "#fbf7f2",
    // Tester item A2, "lock zoom": pinch and double-tap zoom are off in the
    // NATIVE shell, which is the surface that is supposed to read as an app.
    // Stated rather than left to the Capacitor default (also false) so an
    // upgrade cannot quietly flip it. The WEB app deliberately keeps zoom -
    // see the viewport comment in src/app/layout.tsx (WCAG 2.1 SC 1.4.4).
    zoomEnabled: false,
  },
  android: {
    backgroundColor: "#fbf7f2",
    allowMixedContent: false,
    // Same as ios.zoomEnabled above (A2).
    zoomEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: "#fbf7f2",
      showSpinner: false,
      androidSplashResourceName: "splash",
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      // Dark text/icons on the light background_color above. Flipped at
      // runtime if OakTend ever ships a native dark-mode status bar style -
      // see src/lib/native/statusBar.ts.
      style: "DARK",
      backgroundColor: "#fbf7f2",
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
