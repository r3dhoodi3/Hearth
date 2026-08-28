import Link from "next/link";
import { CATEGORIES, THIRD_PARTIES } from "@/lib/privacy";

// Your privacy rights: the one in-app surface for the California rights the
// Terms' governing law points at (CCPA/CPRA, Cal. Civ. Code 1798.100 et seq).
//
// Shared by the homeowner page (/account/privacy) and the pro page
// (/pro/privacy) for the same reason AccountSecurityPanel is shared: pros are
// bounced out of /account by the (app) layout, and two hand-maintained copies
// of a legal disclosure would drift. Only the links differ, so they're props.
//
// Two jobs. It explains each right in plain English, and - for the rights we
// can honour instantly - it gives the actual control rather than an address to
// write to: Download my data hits /api/privacy/export, and deletion links to
// the password-gated control on the caller's own security surface.
//
// The categories and third-party tables are imported from lib/privacy rather
// than retyped here, because the same lists are embedded in every export. One
// source of truth means the page and the file can't drift.

export default function PrivacyRightsPanel({
  // Where this side's password-gated delete + export controls live.
  securityHref,
  // Where this side edits its own identity details (right to correct).
  profileHref,
  profileLabel,
  // Monitored inbox for requests the buttons can't serve. Empty string drops
  // the row rather than rendering a dead mailto.
  contact,
  // This side's blocked-accounts list (/account/blocks or /pro/blocks).
  // Optional: omit it and the safety card below is simply not rendered.
  blocksHref,
}: {
  securityHref: string;
  profileHref: string;
  profileLabel: string;
  contact: string;
  blocksHref?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Your privacy rights
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          What Hearth collects, who we send it to, and how to get it, fix it, or
          delete it. For the full policy, see our{" "}
          <Link
            href="/privacy"
            className="font-medium text-bark-700 hover:underline dark:text-stone-300"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </div>

      {/* Download. The right to know and the right to portability, honoured
          on the spot - the session is the verification, so there's nothing to
          wait for. Plain <a> with download, not a form: the route streams a
          file back rather than redirecting. */}
      <div className="card p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Download your data
            </p>
            <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
              Everything we hold for your account, as a PDF you can read or
              print. Generated fresh each time.
            </p>
            <a
              href="/api/privacy/export?format=json"
              download
              className="mt-1 inline-block text-xs font-medium text-bark-700 hover:underline dark:text-stone-300"
            >
              Also available as JSON
            </a>
          </div>
          <a
            href="/api/privacy/export?format=pdf"
            download
            className="btn-secondary whitespace-nowrap"
          >
            Download my data (PDF)
          </a>
        </div>
      </div>

      {/* The rights themselves. */}
      <div className="card p-6">
        <div className="flex items-center gap-2 border-b border-stone-100 pb-4 dark:border-white/10">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            Your rights as a California resident
          </h2>
        </div>
        <dl className="mt-5 space-y-5">
          <Right
            term="Know what we collect"
            detail="Ask what personal information we've collected about you, where it came from, why we collected it, and who we've sent it to. Download my data above answers this immediately."
          />
          <Right
            term="Get a copy you can take with you"
            detail="Receive your information in a portable, machine-readable format. That's the JSON download above, next to the PDF."
          />
          <Right
            term="Delete your information"
            detail={
              <>
                Have us delete the personal information we collected from you.
                You can do this yourself from{" "}
                <Link
                  href={securityHref}
                  className="font-medium text-bark-700 hover:underline dark:text-stone-300"
                >
                  Account security
                </Link>
                . We may keep a narrow set of records the law requires us to
                keep, such as invoices and payment records.
              </>
            }
          />
          <Right
            term="Correct anything wrong"
            detail={
              <>
                Fix inaccurate personal information. Most of it you can edit
                directly:{" "}
                <Link
                  href={profileHref}
                  className="font-medium text-bark-700 hover:underline dark:text-stone-300"
                >
                  {profileLabel}
                </Link>{" "}
                covers your own details.
                {contact
                  ? " If something you can't edit is wrong, email us."
                  : ""}
              </>
            }
          />
          <Right
            term="Opt out of sale or sharing"
            detail="Hearth does not sell your personal information, and does not share it for cross-context behavioural advertising. There are no advertising or analytics trackers on this site. Because there is nothing to opt out of, there is no Do Not Sell or Share link."
          />
          <Right
            term="Limit how we use sensitive information"
            detail="Some of what you give us is sensitive: your home's precise location, financial details, and the contents of your messages. We use these only to provide Hearth itself - matching you with pros, running your maintenance plan, delivering your messages - never to infer characteristics about you and never for advertising. That is already the limited use this right entitles you to."
          />
          <Right
            term="No retaliation"
            detail="We will never deny you service, charge you a different price, or give you a worse experience for exercising any of these rights."
          />
        </dl>
      </div>

      {/* Categories collected. */}
      <div className="card p-6">
        <div className="flex items-center gap-2 border-b border-stone-100 pb-4 dark:border-white/10">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            What we collect and why
          </h2>
        </div>
        <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
          We keep each of these for as long as your account is open. Deleting
          your account removes it, aside from a narrow set of records we&apos;re
          required to keep, such as invoices and payment records.
        </p>
        <div className="mt-5 space-y-5">
          {CATEGORIES.map((c) => (
            <div key={c.category}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  {c.category}
                </p>
                {c.sensitive && <span className="chip chip-warn">Sensitive</span>}
              </div>
              <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                {c.examples}
              </p>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                <span className="font-medium">Where it comes from:</span>{" "}
                {c.source}
              </p>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                <span className="font-medium">Why we use it:</span> {c.purpose}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Third parties. */}
      <div className="card p-6">
        <div className="flex items-center gap-2 border-b border-stone-100 pb-4 dark:border-white/10">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            Who else sees your information
          </h2>
        </div>
        <p className="mt-4 text-sm text-stone-600 dark:text-stone-400">
          These companies process data on Hearth&apos;s behalf so the product can
          work. Each is limited by contract to doing only what we ask. None of
          them buys your data, and none of them is an advertising network.
        </p>
        <div className="mt-5 space-y-4">
          {THIRD_PARTIES.map((t) => (
            <div key={t.name}>
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                {t.name}{" "}
                <span className="font-normal text-stone-500 dark:text-stone-400">
                  &middot; {t.role}
                </span>
              </p>
              <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                {t.receives}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-5 text-sm text-stone-600 dark:text-stone-400">
          If you post a job, the pros you talk to see your name, contact
          details, address, and what you wrote.
        </p>
      </div>

      {/* Safety controls. Not a privacy right under the CPRA, but this is the
          page people land on when they want to be left alone, and "who can
          reach me" belongs next to "what is held about me". */}
      {blocksHref && (
        <div className="card p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Blocked accounts
              </p>
              <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                Someone you block cannot message you, and you will not be shown
                to each other for new work. You can undo it any time.
              </p>
              <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                To report content or behaviour instead,{" "}
                <Link
                  href="/contact?topic=abuse"
                  className="underline hover:text-stone-600 dark:hover:text-stone-300"
                >
                  tell us what happened
                </Link>
                .
              </p>
            </div>
            <Link href={blocksHref} className="btn-secondary whitespace-nowrap">
              Manage blocks
            </Link>
          </div>
        </div>
      )}

      {/* Anything the buttons can't do. */}
      {contact && (
        <div className="card p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Something else?
              </p>
              <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                Email us for anything the controls above don&apos;t cover,
                including a request made on your behalf by someone you&apos;ve
                authorized. We&apos;ll confirm we got it within 10 business
                days and answer within 45.
              </p>
            </div>
            <a
              href={`mailto:${contact}?subject=${encodeURIComponent("California privacy request")}`}
              className="btn-secondary whitespace-nowrap"
            >
              Email us
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Right({
  term,
  detail,
}: {
  term: string;
  detail: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        {term}
      </dt>
      <dd className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
        {detail}
      </dd>
    </div>
  );
}
