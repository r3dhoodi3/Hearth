import type { Metadata } from "next";
import Link from "next/link";
import { getUser } from "@/lib/auth";
import { getUserProfile } from "@/lib/user";
import ContactForm from "./ContactForm";

// Public top-level page, same pattern as src/app/privacy/page.tsx: see
// src/lib/supabase/middleware.ts for the allowlist entry. Exists so nobody
// has to publish a raw email address to be reachable - every legal page and
// marketing page that used to show FOUNDER.email (src/lib/constants.ts) now
// links here instead, since a real address on a public page got scraped for
// spam almost immediately.
//
// Submissions land in support_messages (supabase/migrations/0024), the same
// table and inbox the in-app Help page (src/app/(app)/account/help) already
// uses - just with user_id left null, since a visitor here has no account.
// See ./actions.ts for the insert, honeypot, and rate limiting.

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Short slugs the app's own links use, spelled out for the visitor. Keys are
// lowercase; anything not listed here is shown back exactly as typed.
const TOPIC_LABELS: Record<string, string> = {
  abuse: "Reporting abuse or a safety concern",
  safety: "Reporting abuse or a safety concern",
};

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Contact us",
  description: "Send Hearth a message. No account needed, and we read every message and will reach out by phone call or email.",
  alternates: {
    canonical: `${SITE_URL}/contact`,
  },
};

export default async function ContactPage(
  props: {
    searchParams?: Promise<{ topic?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  // Optional context from LegalContact's `topic` prop (e.g. "Arbitration
  // opt-out"), shown back to the visitor so they know what they're writing
  // about. Capped, and still never trusted beyond display and a one-line
  // prefix on the stored message.
  const rawTopic =
    typeof searchParams?.topic === "string"
      ? searchParams.topic.trim().slice(0, 120) || null
      : null;
  // A few short slugs the app links to rather than spelling out in a URL.
  // Everything else falls through as the visitor's own words. "abuse" is the
  // one the safety links across the app use (/contact?topic=abuse), so it has
  // to read as a sentence here and not as a bare word.
  const topic = rawTopic ? (TOPIC_LABELS[rawTopic.toLowerCase()] ?? rawTopic) : null;

  // Prefill for a visitor who happens to be signed in, exactly the same three
  // lookups the in-app Help page feeds SupportForm with (src/app/(app)/account/
  // help/page.tsx). No account, no prefill: both helpers return null with no
  // session, and the page keeps working for a logged-out visitor.
  //
  // This costs no static rendering: reading searchParams above already makes
  // this route dynamic, so the session read rides along on a render that was
  // never going to be cached. Only name / email / phone leave this function -
  // never the rest of the profile row.
  const [profile, user] = await Promise.all([getUserProfile(), getUser()]);
  const metaName = (
    user?.user_metadata?.full_name as string | undefined
  )?.trim();
  const prefill = {
    name: profile?.full_name || metaName || "",
    email: profile?.email || user?.email || "",
    phone: profile?.phone || "",
  };

  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <p className="text-sm">
        {/* Back link: a bare 14px text link is a thumb-sized miss on a
            phone, so below sm it becomes a real 44px tall target at 16px.
            The sm and up rendering is untouched: every added class is
            max-sm:. Same treatment on every public page that carries this
            link (terms, privacy, dmca, pricing, ai-disclosure, pro-terms,
            emergency-help). */}
        <Link href="/" className="text-stone-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-base dark:text-stone-400 dark:hover:text-stone-300">
          ← Hearth
        </Link>
      </p>

      <h1 className="mt-4 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Contact us
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Send us a message below. No account needed. We read every message and
        will reach out by phone call or email.
      </p>

      <div className="mt-8">
        <ContactForm
          topic={topic}
          name={prefill.name}
          email={prefill.email}
          phone={prefill.phone}
        />
      </div>
    </main>
  );
}
