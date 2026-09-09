// Android App Links config, served at
// https://oaktend.com/.well-known/assetlinks.json
//
// Google Play fetches this to verify the OakTend Android app is allowed to
// open oaktend.com links directly (App Links, the Android equivalent of
// Apple's Universal Links). Needs the app's package name (matches
// capacitor.config.ts's appId) and its release-signing certificate's SHA-256
// fingerprint.
//
// TODO(appstore): "sha256_cert_fingerprints" below is a PLACEHOLDER. Once
// Landen has generated (or Play App Signing has generated) the real upload/
// release keystore, replace the placeholder with the real fingerprint:
//   keytool -list -v -keystore <release-key>.jks | grep SHA256
// or, if using Play App Signing, copy it from Play Console > Setup > App
// signing. This file is syntactically complete but will not verify against a
// real app until that fingerprint is filled in.
export const dynamic = "force-static";

export async function GET() {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.oaktend.app", // TODO(appstore): confirm matches the real Android package name
        sha256_cert_fingerprints: [
          "TODO_APPSTORE_REPLACE_WITH_RELEASE_SHA256_FINGERPRINT",
        ],
      },
    },
  ];

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
