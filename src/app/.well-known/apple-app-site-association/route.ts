// Apple Universal Links config, served at
// https://oaktend.com/.well-known/apple-app-site-association
//
// Apple fetches this file (no extension, must be valid JSON, must be served
// with a JSON-compatible content type - Apple does not require
// application/json specifically, but rejects a response that isn't parseable
// as JSON) over HTTPS the FIRST time the OakTend app is installed, and caches
// it. It has to be reachable with no auth and no redirect.
//
// TODO(appstore): TEAMID and the bundle id below are PLACEHOLDERS. Once
// Landen has the real 10-character Apple Developer Team ID (App Store
// Connect > Membership) and the confirmed bundle id (capacitor.config.ts's
// appId, currently com.oaktend.app), replace "TEAMID.com.oaktend.app" below
// with the real "<TeamID>.<BundleID>" string and add the
// "com.apple.developer.associated-domains" entitlement
// ("applinks:oaktend.com") in Xcode's Signing & Capabilities tab. Until then
// this file is syntactically complete but will not resolve to a real app.
//
// "paths": ["*"] opens every oaktend.com path to Universal Links (shared job
// links, push notification deep links, SMS links). If a specific path should
// stay a plain web link even with the app installed (rare - e.g. a page
// meant for a signed-out visitor's browser, not the app), add it to the
// "NOT" exclusion array here rather than narrowing the wildcard, so this file
// doesn't have to be kept in sync with every new route OakTend adds.
export const dynamic = "force-static";

export async function GET() {
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appID: "TEAMID.com.oaktend.app", // TODO(appstore): replace TEAMID with the real Apple Developer Team ID
          paths: ["*"],
        },
      ],
    },
    // webcredentials lets the app and Safari share saved passwords/passkeys
    // for the same domain, once/if OakTend adds passkey support. Harmless to
    // declare now; unused until then.
    webcredentials: {
      apps: ["TEAMID.com.oaktend.app"], // TODO(appstore): same TEAMID replacement as above
    },
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Apple caches this itself; a short edge cache is enough to keep this
      // route cheap without risking a stale TEAMID lingering after it's
      // filled in.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
