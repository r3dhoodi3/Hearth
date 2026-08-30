import type { Metadata } from "next";
import Link from "next/link";

// Confirmation page for the public /contact form. Used to be a flash toast on
// top of whatever page the visitor landed on next (home page, or their
// dashboard if signed in) - easy to miss, and it said nothing about what
// happens next. src/app/contact/actions.ts now redirects every successful
// send here instead of setFlash()+redirect(). Static: no session read, no
// searchParams, so it builds and serves like the rest of the public marketing
// pages (guides, pricing, city pages) rather than paying for a dynamic render
// on a page that has nothing user-specific to show.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Message sent",
  description: "Your message to Hearth was sent.",
  alternates: {
    canonical: `${SITE_URL}/contact/thanks`,
  },
  // Not a page anyone should land on from search - it only exists as a
  // redirect target right after a form submit.
  robots: { index: false, follow: true },
};

export default function ContactThanksPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <p className="text-sm">
        {/* Same 44px-on-phone back link as the rest of the public pages
            (contact, terms, privacy, dmca, pricing, ai-disclosure,
            pro-terms, emergency-help) - see contact/page.tsx's comment. */}
        <Link
          href="/"
          className="text-stone-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-base dark:text-stone-400 dark:hover:text-stone-300"
        >
          ← Hearth
        </Link>
      </p>

      <h1 className="mt-4 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Message sent
      </h1>
      <p className="mt-3 text-sm text-stone-600 dark:text-stone-300">
        We read every message and will reach out by phone call or email.
      </p>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link href="/" className="btn-primary text-center">
          Back to Hearth
        </Link>
        <Link href="/guides" className="btn-secondary text-center">
          Browse the guides
        </Link>
      </div>
    </main>
  );
}
