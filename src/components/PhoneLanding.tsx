import Link from "next/link";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";

// The phone landing: everything a visitor who already downloaded the app
// needs, and nothing else.
//
// Someone arriving here on a phone came from the App Store listing or from a
// friend's link. They already know what Hearth is; the marketing page is for
// desktop search traffic. So the phone gets one screen: the wordmark, one
// line of what this is, and the two doors (new account, existing account).
// Every marketing section on the landing page is hidden below `sm` instead
// (`max-sm:hidden` on each section wrapper in src/app/page.tsx) - hidden, not
// deleted, so desktop is byte-identical and the copy still gets indexed.
//
// The tour that used to live on the landing page ("How it works", "What
// Hearth watches for you") is now the post-login guide, src/components/
// AppGuide.tsx, which is where it actually helps.
//
// SIZING: this whole block lands in roughly 400px, so it clears the fold on a
// 390x844 phone with room to spare even with the browser chrome. Keep it that
// way - the two buttons are the point of the screen.
//
// `sm:hidden` on the wrapper is the counterpart to the `max-sm:hidden` marks
// in page.tsx: exactly one of the two landings renders at any width, and the
// desktop one is untouched.
export default function PhoneLanding() {
  return (
    <div className="sm:hidden">
      {/* The full header is hidden on phone, so the wordmark and the theme
          switch live here instead. Nothing else from that header is lost:
          its two links (Emergency help, Hearth for Pros) are in the quiet
          row below. */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 font-semibold text-stone-900 dark:text-stone-100">
          <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" /> Hearth
        </span>
        <ThemeToggle />
      </div>

      {/* Deliberately an h1: the desktop hero's h1 is display:none at this
          width, so without one here a phone screen reader would land on a
          page with no top-level heading. Only ever one of the two is
          visible. */}
      <h1 className="mt-12 text-3xl font-semibold tracking-tight text-stone-900 dark:text-stone-100 [text-wrap:balance]">
        Your home, looked after.
      </h1>
      <p className="mt-3 text-base leading-relaxed text-stone-600 dark:text-stone-400">
        Hearth checks on your home for you and warns you before things break.
      </p>

      {/* The two doors, stacked and full width. min-h-12 (48px) is above the
          44px thumb minimum .btn already enforces; on this screen they should
          read as the only two things to do. */}
      <div className="mt-8 flex flex-col gap-3">
        <Link
          href="/homeowner-signup"
          className="btn-primary min-h-12 w-full text-base"
        >
          Create your account
        </Link>
        <Link
          href="/signin"
          className="btn-secondary min-h-12 w-full text-base"
        >
          Sign in
        </Link>
      </div>

      {/* Quiet row: the two doors that are not "sign up as a homeowner".
          Small text, no buttons - they should not compete with the two
          above. Each link still clears a 44px tap target even though the
          row reads small. Privacy lives in the phone footer only now
          (src/app/page.tsx); it used to repeat here too, a few hundred
          pixels above its own footer. */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-stone-500 dark:text-stone-400">
        <Link
          href="/pros"
          className="inline-flex min-h-11 items-center py-1 hover:text-bark-700 dark:hover:text-stone-300"
        >
          I&apos;m a contractor
        </Link>
        <Link
          href="/emergency-help"
          className="inline-flex min-h-11 items-center py-1 hover:text-bark-700 dark:hover:text-stone-300"
        >
          Emergency help
        </Link>
      </div>
    </div>
  );
}
