import Link from "next/link";
import { startBackgroundCheckAction } from "../actions";
import { BACKGROUND_CHECK_MIN_PAID_LEADS } from "@/lib/constants";
import type { Contractor } from "@/lib/database.types";

// Opt-in Checkr background check (0057). Only ever rendered by
// ProfileTabs/page.tsx when isCheckrConfigured() is true - fully dormant
// (this component never mounts) without CHECKR_API_KEY set. Matches the
// license verification block's style and honesty rules (PublicProfileForm.tsx):
// never claim a check happened beyond what a real Checkr webhook confirmed,
// and 'consider' stays private-only, same as license_verify_detail on a
// 'failed' CSLB check.
function formatCheckedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function BackgroundCheckCard({
  contractor,
  paidLeads,
}: {
  contractor: Contractor;
  // Paid lead applications this pro has, counted server-side (see
  // countPaidLeadApplications). Hearth pays Checkr per check, so the perk is
  // earned rather than granted at signup. Null means the count could not be
  // read; the card treats that the same way the server action does - as not
  // yet unlocked - so the UI never offers a button the action will refuse.
  paidLeads: number | null;
}) {
  const status = contractor.background_check_status ?? "none";
  const checkedAt = contractor.background_checked_at ?? null;
  const hasEmail = Boolean(contractor.contact_email);
  const paidLeadsKnown = typeof paidLeads === "number" ? paidLeads : 0;
  const unlocked = paidLeadsKnown >= BACKGROUND_CHECK_MIN_PAID_LEADS;

  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-semibold text-stone-900 dark:text-stone-100">Background check</h2>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Run by Checkr, a background check provider. Hearth covers the cost:
          it&apos;s free for you, and it unlocks after{" "}
          {BACKGROUND_CHECK_MIN_PAID_LEADS} paid leads. Consent and the check
          itself happen on Checkr&apos;s site, after they email you an
          invitation. Hearth only ever sees a pass / no-pass result, never the
          report itself.
        </p>
      </div>

      {status === "clear" ? (
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Background checked
          </span>
          <p className="mt-1 text-xs text-green-600 dark:text-green-400">
            Cleared{checkedAt ? ` on ${formatCheckedDate(checkedAt)}` : ""}.
            This appears on your public page.
          </p>
        </div>
      ) : status === "consider" ? (
        <div>
          <p className="text-xs text-red-500 dark:text-red-400">
            The check did not clear. This is never shown publicly - only you
            can see this. Questions?{" "}
            <Link href="/pro/help" className="underline hover:text-red-600 dark:hover:text-red-300">
              Contact support
            </Link>
            .
          </p>
        </div>
      ) : status === "pending" ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Your background check is in progress. We&apos;ll update this as
          soon as Checkr reports back.
        </p>
      ) : status === "invited" ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Check your email for Checkr&apos;s invitation to complete your
          background check.
        </p>
      ) : !unlocked ? (
        // Quiet progress, not a locked button: the meter counts something the
        // pro is already doing, and the number is the same one the server
        // action enforces.
        <div className="space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-700">
            <div
              className="h-full rounded-full bg-hearth-500 transition-all"
              style={{
                width: `${Math.round(
                  (paidLeadsKnown / BACKGROUND_CHECK_MIN_PAID_LEADS) * 100
                )}%`,
              }}
            />
          </div>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Included after {BACKGROUND_CHECK_MIN_PAID_LEADS} paid leads -
            you&apos;re at {paidLeadsKnown} of{" "}
            {BACKGROUND_CHECK_MIN_PAID_LEADS}.
          </p>
        </div>
      ) : hasEmail ? (
        <form action={startBackgroundCheckAction} className="space-y-2">
          {/* Legal name, not the business name: the check runs against a
              person. Sent to Checkr only, never stored by Hearth. */}
          <div className="flex flex-wrap gap-2">
            <input
              name="legal_first_name"
              required
              maxLength={80}
              placeholder="Legal first name"
              className="input max-w-[180px] text-base sm:text-xs"
            />
            <input
              name="legal_last_name"
              required
              maxLength={80}
              placeholder="Legal last name"
              className="input max-w-[180px] text-base sm:text-xs"
            />
          </div>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Your legal name goes to Checkr to run the check. Hearth doesn&apos;t
            store it.
          </p>
          <button
            type="submit"
            // Same phone-only bump as the license Verify button next to it
            // (PublicProfileForm.tsx): 44px below sm, untouched from sm up.
            className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-4 dark:border-white/10 dark:text-stone-300 dark:hover:bg-stone-700"
          >
            Start my background check
          </button>
        </form>
      ) : (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Add an email address above first, then come back to start your
          background check.
        </p>
      )}
    </section>
  );
}
