import Link from "next/link";
import SessionCta from "@/components/SessionCta";
import Logo from "@/components/Logo";

// Shared shell for the public /guides pages: informational content meant to
// be indexed and read by anonymous search visitors (see the middleware
// allowlist in src/lib/supabase/middleware.ts). Same quiet header/footer on
// every guide so the section reads as one place, not six one-off pages.
//
// Session-aware header: a signed-in reader (with a personal AI experience one
// click away) landing on "Get started free" after clicking in from search or
// a guide link is a tonal whiplash, and dishonest besides - they already
// started.
//
// NOW STATIC. This layout used to `await getVerifiedUser()` here, purely to
// pick between those two labels, and a layout's dynamic read opts its whole
// subtree out - so one auth round trip cost the guides index and all 12 guide
// pages their prerender, and put a network hop to Supabase's auth server on
// the blocking path in front of every guide's content. The old comment in this
// spot spelled out the fix and asked for it in its own pass: resolve the
// session in the browser inside one small client component shared by this
// header and GuideCta. That is src/components/SessionCta.tsx, and this is that
// pass.
//
// Nothing in this file reads cookies(), headers() or the session any more, and
// neither does GuideCta (also a client component now), so the guide pages
// prerender at build time and are served from the CDN. The trade is written up
// in SessionCta.tsx: a signed-in reader sees "Get started free" until
// hydration swaps it, which is milliseconds, contained to this one button, and
// bought at the price of the whole section no longer waking a serverless
// function to render text that never changes.
//
// KEEP THIS FILE FREE OF cookies(), headers() AND ANY SESSION READ, for the
// same reason src/app/layout.tsx carries that instruction: one of them here
// puts all 13 pages back on the dynamic path.
export default function GuidesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-6 pt-6">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold text-stone-900 dark:text-stone-100"
        >
          <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" /> Hearth
        </Link>
        <SessionCta signedOutHref="/get-started" />
      </header>

      {children}

      <footer className="mx-auto mt-16 max-w-2xl border-t border-stone-200 px-6 py-6 text-center dark:border-white/10">
        <p className="inline-flex w-full items-center justify-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
          <Logo className="h-4 w-4 text-bark-700 dark:text-stone-400" /> Hearth · Your home, looked after
        </p>
        <p className="mt-2 text-xs">
          <Link
            href="/guides"
            className="text-stone-500 hover:text-bark-700 hover:underline dark:text-stone-400 dark:hover:text-stone-300"
          >
            All guides
          </Link>{" "}
          ·{" "}
          <Link
            href="/privacy"
            className="text-stone-500 hover:text-bark-700 hover:underline dark:text-stone-400 dark:hover:text-stone-300"
          >
            Privacy
          </Link>{" "}
          ·{" "}
          <Link
            href="/terms"
            className="text-stone-500 hover:text-bark-700 hover:underline dark:text-stone-400 dark:hover:text-stone-300"
          >
            Terms
          </Link>
        </p>
      </footer>
    </div>
  );
}
