import Logo from "@/components/Logo";
import OpenRedirect from "./OpenRedirect";

// PWA launch shell: the installed app's start_url (see src/app/manifest.ts).
//
// The manifest used to point straight at /dashboard, and on a serverless cold
// start the dashboard's server work plus the signed-out 307 to /signin left
// the installed app showing a blank white screen for seconds. This page is the
// fix: it is force-static, so the CDN serves it instantly even when every
// server function is cold, it paints the brand immediately, and then the tiny
// client component forwards to the dashboard, which still owns the auth
// bounce. For that to hold it must read no cookies, no params, and no
// database on the server, and it must stay free of the shared app shell so no
// heavy client JS rides along.
export const dynamic = "force-static";

export default function OpenPage() {
  return (
    // min-h-dvh + safe-area padding: full-screen and centered on a notched
    // phone in standalone display mode, identical on desktop. bg-bark-50 is
    // #fbf7f2, the manifest's background_color, so the first paint continues
    // the splash background with no color jump; dark mode follows the body's
    // usual dark:bg-stone-900.
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bark-50 px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-center dark:bg-stone-900">
      <div className="flex items-center gap-2 text-2xl font-semibold text-stone-900 dark:text-stone-100">
        <Logo className="h-8 w-8 text-bark-700 dark:text-stone-400" />
        <span>Hearth</span>
      </div>
      {/* animate-pulse doubles as the spinner: a quiet fade loop reads as
          "working" without shipping a keyframe or an extra element. */}
      <p className="animate-pulse text-sm text-stone-500 dark:text-stone-400">
        Opening Hearth...
      </p>
      <OpenRedirect />
      {/* With JavaScript off the redirect above never runs, so hand over a
          plain link to the same destination instead of a screen that pulses
          forever. */}
      <noscript>
        <a href="/dashboard" className="text-sm underline">
          Open Hearth
        </a>
      </noscript>
    </main>
  );
}
