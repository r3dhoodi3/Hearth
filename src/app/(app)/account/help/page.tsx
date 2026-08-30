import Link from "next/link";
import { getUserProfile } from "@/lib/user";
import { getUser } from "@/lib/auth";
import SupportForm from "./SupportForm";
import ShowAppGuideButton from "@/components/ShowAppGuideButton";
import Breadcrumbs from "@/components/Breadcrumbs";

const FAQ: { q: string; a: string; href?: string; hrefLabel?: string }[] = [
  {
    q: "How does Hearth know about my home?",
    a: "When you claim your address, Hearth looks up public property records and builds a starter profile. You can add or edit your systems, their ages, and their condition at any time from the Home page.",
  },
  {
    q: "How do I get quotes from contractors?",
    a: "Post a job from the Post a Job page or ask Hearth to help. Local pros can then message you, and any price they send in chat is captured so you can compare them side by side.",
  },
  {
    q: "What is Ask Hearth?",
    a: "Ask Hearth is your home assistant. It answers questions using your own systems and their ages, reads photos of labels or documents, and can log issues, set reminders, and post jobs for you.",
  },
  {
    q: "Is my data private?",
    a: "Your home data is yours. Every record is protected so that only you can see your home, and you can delete your account and all associated data at any time from Account security.",
  },
  {
    q: "How does Hearth decide when something needs maintenance?",
    a: "Hearth uses your system's typical lifespan and the age you gave it to flag what is coming due.",
    href: "/guides/home-maintenance-schedule",
    hrefLabel: "See the full maintenance schedule",
  },
  {
    q: "How do I know if a contractor's quote is fair?",
    a: "Ask Hearth to read the quote with you, or check it against the red flags in our guide.",
    href: "/guides/is-my-contractor-quote-fair",
    hrefLabel: "Is my contractor's quote fair?",
  },
  {
    q: "What if I have a slow leak or a spike in my water bill?",
    a: "That can be an early sign of a slab leak, especially in an older home. Our guide covers what to look for and when it is an emergency.",
    href: "/guides/slab-leak-signs",
    hrefLabel: "Slab leak signs",
  },
];

export default async function HelpPage(props: {
  searchParams?: Promise<{ sent?: string }>;
}) {
  const [profile, user, searchParams] = await Promise.all([
    getUserProfile(),
    getUser(),
    props.searchParams,
  ]);
  const metaName = (
    user?.user_metadata?.full_name as string | undefined
  )?.trim();
  const name = profile?.full_name || metaName || "";
  const email = profile?.email || user?.email || "";
  const phone = profile?.phone || "";
  // Set by saveSupportMessageAction's post-success redirect (./actions.ts)
  // so SupportForm can swap itself for a confirmation card instead of the
  // plain form on the reload.
  const sent = searchParams?.sent === "1";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Breadcrumbs
        items={[
          { label: "Home", href: "/dashboard" },
          { label: "Account", href: "/account" },
          { label: "Help" },
        ]}
      />
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Help</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Answers to common questions, and how to reach us.
        </p>
      </div>

      <div className="card">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Frequently asked questions
        </h2>
        <div className="mt-3 divide-y divide-stone-100 dark:divide-white/10">
          {FAQ.map((f) => (
            <details key={f.q} className="group py-3">
              {/* Phone only: ~20px per question, and there is one per row. */}
              <summary className="cursor-pointer text-sm font-medium text-stone-900 marker:text-stone-500 max-sm:flex max-sm:min-h-11 max-sm:items-center max-sm:text-base dark:text-stone-100 dark:marker:text-stone-400">
                {f.q}
              </summary>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">{f.a}</p>
              {f.href && (
                <Link
                  href={f.href}
                  className="mt-2 inline-block text-sm font-medium text-bark-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
                >
                  {f.hrefLabel} →
                </Link>
              )}
            </details>
          ))}
        </div>
      </div>

      <div id="support-form">
        <SupportForm name={name} email={email} phone={phone} sent={sent} />
      </div>

      {/* Found a bug: reports go through the support form on this page, same
          inbox as everything else - not a mailto link, which dumped people
          into whatever desktop mail app the OS picked. No credit offer here:
          Hearth has no homeowner wallet or credit to pay one out (that's a
          pro-side thing), so promising one would be a bug of its own. */}
      <div className="card">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Found a bug?
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Tell us about it. We read every report and fix what we can.
        </p>
        <a
          href="#support-form"
          className="mt-3 inline-block text-sm font-medium text-bark-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
        >
          Report a bug
        </a>
      </div>

      {/* Safety. Separate from the bug card above on purpose: someone being
          harassed should not have to work out whether that counts as a bug.
          Goes to the public /contact form rather than the support form on
          this page, so the same route works whether or not they are signed in
          when they come back to it. */}
      <div className="card">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Safety
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          You can report a message, a review, or a business from where you see
          it, and block anyone you do not want to hear from again.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          <Link
            href="/contact?topic=abuse"
            className="text-sm font-medium text-bark-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
          >
            Report abuse or a safety concern
          </Link>
          <Link
            href="/account/blocks"
            className="text-sm font-medium text-bark-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300"
          >
            Blocked accounts
          </Link>
        </div>
      </div>

      {/* The four-card guide from your first sign-in, on demand. Reopens it
          in place (a window event, no navigation) - see
          src/components/ShowAppGuideButton.tsx. */}
      <div className="card">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          New to Hearth?
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          A one-minute look at what Hearth watches, what it asks of you, and
          how to find a pro.
        </p>
        <div className="mt-2">
          <ShowAppGuideButton />
        </div>
      </div>

      <p className="text-sm text-stone-500 dark:text-stone-400">
        You can also ask Hearth directly from the assistant on any page.
      </p>
    </div>
  );
}
