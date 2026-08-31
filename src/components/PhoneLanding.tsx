import Link from "next/link";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";

// The phone landing: everything a visitor who already downloaded the app
// needs, plus just enough substance that the screen does not read as empty.
//
// Someone arriving here on a phone came from the App Store listing or from a
// friend's link. They may be a homeowner or a contractor, so the screen leads
// with two role doors (homeowner signup, contractor signup), then a quieter
// sign-in for people who already have an account, then three one-line reasons
// to walk through a door. Every marketing section on the landing page is
// hidden below `sm` instead (`max-sm:hidden` on each section wrapper in
// src/app/page.tsx) - hidden, not deleted, so desktop is byte-identical and
// the copy still gets indexed.
//
// The tour that used to live on the landing page ("How it works", "What
// Hearth watches for you") is now the post-login guide, src/components/
// AppGuide.tsx, which is where it actually helps.
//
// SIZING: this whole block lands in roughly 600px. The two role doors and the
// sign-in link all sit inside the first ~420px, so they clear the fold on a
// 390x844 phone even with the browser chrome; only the benefit rows and the
// quiet row can fall below it. Keep it that way - the doors are the point.
//
// The doors stay single-line on purpose: .btn (globals.css) is a row flex
// tuned to center a single line inside its 44px minimum, and a sub-line
// would need a nested column span plus extra height the fold budget does
// not have. The benefit rows carry the extra words instead.
//
// `sm:hidden` on the wrapper is the counterpart to the `max-sm:hidden` marks
// in page.tsx: exactly one of the two landings renders at any width, and the
// desktop one is untouched.

// One-line benefit rows. Icons are drawn to match Logo.tsx: 24-box viewBox,
// stroke currentColor at 1.8, round caps and joins, no fill.
const benefits = [
  {
    label: "Freeze and heat warnings before things break.",
    // Thermometer.
    icon: (
      <path d="M14 14.76V5.5a2.5 2.5 0 0 0-5 0v9.26a4.5 4.5 0 1 0 5 0z" />
    ),
  },
  {
    label: "Maintenance reminders for what your home has.",
    // Bell.
    icon: (
      <>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </>
    ),
  },
  {
    label: "Local pros, fee shown before you post a job.",
    // Map pin.
    icon: (
      <>
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </>
    ),
  },
];

export default function PhoneLanding() {
  return (
    <div className="sm:hidden">
      {/* The full header is hidden on phone, so the wordmark and the theme
          switch live here instead. Nothing else from that header is lost:
          its pro door is now the contractor button below, and Emergency
          help is in the quiet row at the bottom. */}
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

      {/* The two role doors, stacked, full width, equal size. min-h-12 (48px)
          is above the 44px thumb minimum .btn already enforces. Each goes
          STRAIGHT to its real signup form, not to a "who are you?" fork:
          this screen is the fork. */}
      <div className="mt-8 flex flex-col gap-3">
        <Link
          href="/homeowner-signup"
          className="btn-primary min-h-12 w-full text-base"
        >
          I&apos;m a homeowner
        </Link>
        <Link
          href="/contractor-signup"
          className="btn-secondary min-h-12 w-full text-base"
        >
          I&apos;m a contractor
        </Link>
      </div>

      {/* Sign in stays under the doors but visually below them in weight: a
          plain full-width text link, not a third button, so the hierarchy
          reads doors first. min-h-11 keeps the whole line a 44px target. */}
      <Link
        href="/signin"
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center text-sm text-stone-600 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300"
      >
        {"Already have an account? "}
        <span className="font-medium underline underline-offset-2">
          Sign in
        </span>
      </Link>

      {/* Three one-line reasons to pick a door. This is deliberately a list,
          not a marketing section: no headings, no paragraphs, so the tour
          stays in AppGuide.tsx where it belongs. Each line is short enough
          to stay on one line at 390px. */}
      <ul className="mt-8 flex flex-col gap-3">
        {benefits.map(({ label, icon }) => (
          <li
            key={label}
            className="flex items-center gap-3 text-sm text-stone-600 dark:text-stone-400"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5 shrink-0 text-bark-700 dark:text-stone-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {icon}
            </svg>
            {label}
          </li>
        ))}
      </ul>

      {/* Quiet row: just Emergency help now that the contractor door is a
          real button above. Small text, no button - it should not compete
          with the doors, but the link still clears a 44px tap target.
          Privacy lives in the phone footer only (src/app/page.tsx); it used
          to repeat here too, a few hundred pixels above its own footer. */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-stone-500 dark:text-stone-400">
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
