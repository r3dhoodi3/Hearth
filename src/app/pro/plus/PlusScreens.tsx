"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/app/pro/leads/LeadsBoard.tsx, src/app/pro/chats/ChatsView.tsx and
// src/app/pro/help/HelpView.tsx, investigated in scratchpad/debug-DBG3.md.
//
// React Flight defers any element it meets once the row it is serializing has
// passed a 3200-byte budget: it writes "$L<id>" in place and starts a fresh
// row for that element. Fizz then has to stream each of those rows as an
// out-of-order segment - a <template id="P:n"> hole nested inside the page's
// own markup plus a late $RS(...) script to fill it - and that hole chain is
// the shape that comes with the React #418 / "$RS ... parentNode" hydration
// failure reported on the pro pages.
//
// /pro/plus still carried two deferrals after PerksList moved out: measured
// live, the pitch branch chopped the LAST perk's icon element out of
// PerksList's props and then the closing "Questions about billing?" line -
// both past byte ~4550 of the page row. The icon half is fixed in PerksList
// itself (it takes a name now, not an element); this file is the other half.
//
// Every branch of the page renders through one of the components below, so the
// page's own Flight row is a single client reference carrying plain data -
// strings, booleans and server-action references - with no element after it to
// defer. All four branches live here for that reason: leaving one behind in
// the page would put server markup back in that row.
//
// Nothing here is newly interactive and nothing is newly computed on the
// client. ProPlanToggle, ConfirmSubmit and next/link were already client
// components; AutoRenewalTerms and PerksList are pure markup over pure data.
// Anything that reads the clock or the locale - the renewal date, the trial
// end date, the cancellation copy that names them - is still resolved on the
// server and arrives here as a finished string, so hydration cannot disagree
// with SSR about it.

import Link from "next/link";
import { PRO_DEPOSIT_BOOST_PTS, PRO_LEADS_HREF } from "@/lib/constants";
import ProPlanToggle from "./ProPlanToggle";
import PerksList, { PERKS } from "./PerksList";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";

/** A server action with no arguments, handed down as a `<form action>`. */
type FormAction = () => Promise<void>;

// One-time confirmation right after checkout. Rendered off the ?welcome=1 flag
// so it appears even if the Stripe webhook hasn't synced the subscription yet.
export function PlusWelcome({
  showTrialCaveat,
  renewalPlan,
  renewalIntroEligible,
}: {
  /** True when the subscription row is absent or still "trialing". */
  showTrialCaveat: boolean;
  /** null when Stripe's row hasn't landed yet, which is the common race here. */
  renewalPlan: "pro_yearly" | "pro_monthly" | null;
  renewalIntroEligible: boolean;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-6 text-center">
      <div>
        <h1 className="text-3xl font-semibold text-stone-900 dark:text-stone-100">
          You&apos;re a Hearth Pro member
        </h1>
        <p className="mt-2 text-stone-600 dark:text-stone-300">
          Your perks are switching on now. Here&apos;s what you just added to
          your toolbox:
        </p>
      </div>
      {/* Streaming fix, not a layout change: see PerksList.tsx's header
          comment and scratchpad/debug-DBG3.md - this block used to be
          PERKS.map() rendered inline here, at the tail of a long Server
          Component row. */}
      <PerksList perks={PERKS} variant="welcome" />
      {/* The two perks with money attached are perks of a PAID cycle: the
          Stripe webhook grants the wallet credit off the first real invoice
          (not the $0 one a trial start finalizes) and applies the deposit
          match only against an "active" row. Say so rather than let a trialer
          go looking for $10 that has not landed or deposit expecting a match
          that will not apply. This screen renders off ?welcome=1 and
          routinely BEATS the webhook, so the row is usually still null here:
          gating only on "trialing" would suppress the caveat exactly when a
          fresh trial buyer needs it. Show it whenever the row is absent or
          reads "trialing" - both are the held-back case - so a trial buyer is
          never told to go looking for $10 that has not landed. */}
      {showTrialCaveat && (
        <p className="mx-auto max-w-md text-left text-xs text-stone-500 dark:text-stone-400">
          Two of these start when your free trial converts and your first
          payment goes through: your first $10 of lead credit, and your{" "}
          +{PRO_DEPOSIT_BOOST_PTS}% deposit match. Deposits during the trial
          earn the normal tier bonus. Every other perk is on right now.
        </p>
      )}
      {/* Post-purchase acknowledgment (Bus. & Prof. Code 17602(a)(3)): the
          renewal terms, the cancellation policy, and how to cancel. Both
          cadences can state the real numbers now that the offer is a Stripe
          trial rather than a coupon: the trial either shows on the row as
          status "trialing" or it doesn't, so nothing has to be guessed. The
          fallback still covers the real race here - this screen renders off
          ?welcome=1 and can beat the Stripe webhook that writes the row - and
          defers to the emailed acknowledgment, which the webhook builds from
          the subscription Stripe actually created. */}
      <div className="mx-auto max-w-md">
        {renewalPlan ? (
          <AutoRenewalTerms
            plan={renewalPlan}
            introEligible={renewalIntroEligible}
            variant="acknowledgment"
          />
        ) : (
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-left dark:border-white/10 dark:bg-stone-900">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Your Hearth Pro renewal terms
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-stone-600 dark:text-stone-300">
              <li>Hearth Pro renews automatically until you cancel.</li>
              <li>
                Your confirmation email has the exact amount and date.
              </li>
              <li>
                Cancel anytime with the &quot;Cancel membership&quot; button
                on this page. No call or email needed.
              </li>
              <li>
                On a free trial, cancel before it ends and you won&apos;t be
                charged.
              </li>
            </ul>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-3">
        {/* "Find jobs" rather than "Back to my leads": after the pro Home /
            Leads split this button goes to the board, and naming the ACTION
            is what a pro who just paid is here to do. Through
            PRO_LEADS_HREF so it follows the board wherever it lives. */}
        <Link href={PRO_LEADS_HREF} className="btn-primary">
          Find jobs
        </Link>
        <p className="text-xs text-stone-500 dark:text-stone-400">
          If a perk still looks off, give it a minute to sync, then refresh.
        </p>
      </div>
    </div>
  );
}

// The member's own screen: what they are paying for, when it renews, and the
// two ways out.
export function PlusMember({
  planLabel,
  periodSuffix,
  cancelsAtLabel,
  cancelNote,
  trialing,
  manageAction,
  resumeAction,
  cancelAction,
}: {
  /** "Yearly" or "Monthly", decided on the server. */
  planLabel: string;
  /** The " · renews 1/2/2027" tail, already formatted, or "" when unknown. */
  periodSuffix: string;
  /** Set only when a cancellation is already pending: the lapse date. */
  cancelsAtLabel: string | null;
  /** null when there is nothing to cancel (no Stripe subscription id). */
  cancelNote: string | null;
  trialing: boolean;
  manageAction: FormAction;
  resumeAction: FormAction;
  cancelAction: FormAction;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Hearth Pro</h1>
      </div>
      <div className="card space-y-4 text-center">
        <p className="text-lg font-medium text-hearth-700 dark:text-hearth-300">
          You&apos;re a Hearth Pro member
        </p>
        {/* During the trial, current_period_end IS the trial end, so calling
            it a renewal would hide the thing that actually matters: the date
            the first charge lands. Say which it is. */}
        <p className="text-sm text-stone-500 dark:text-stone-400">
          {planLabel} plan
          {periodSuffix}
        </p>
        <form action={manageAction}>
          <button className="btn-secondary">Manage billing</button>
        </form>
        {cancelsAtLabel && (
          <div className="space-y-2 border-t border-stone-100 pt-4 dark:border-white/10">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Your membership ends on {cancelsAtLabel}. You
              keep every perk until then, and your lead access never changes.
            </p>
            <form action={resumeAction}>
              <button className="btn-secondary">Keep my membership</button>
            </form>
          </div>
        )}
        {/* The date the membership would actually lapse. With no pending
            cancellation yet there is no cancelsAt to read, and Stripe ends
            the subscription at the end of the paid period, so
            current_period_end IS that date (it is also the trial end while
            status is "trialing" - see the note above). Null when Stripe has
            not reported a period end, in which case the copy below falls
            back to naming no date rather than inventing one. */}
        {cancelNote && (
          <div className="border-t border-stone-100 pt-4 dark:border-white/10">
            <form action={cancelAction}>
              {/* Cancelling during the trial is the case the law cares most
                  about, and "the time you've paid for" would be wrong for it:
                  nothing has been paid yet, and the point is that nothing
                  will be.

                  Both notes now name the real end date and the real
                  consequences instead of the vague "every perk". Every
                  clause was checked against migration 0112's
                  public_pro_profile body: logo_url and about are
                  `case when m.live`, is_before is `ph.is_before and m.live`,
                  and rating / review_count / has_license /
                  license_verified_at / background_checked_at carry no m.live
                  term at all. The project LIST is not gated either (the RPC
                  returns up to 12 for everyone), so nothing already
                  published disappears - only the Before/After labels come
                  off, and the cap applies to ADDING a 4th
                  (project-actions.ts FREE_PROJECT_LIMIT). The share kit and
                  the rating-widget embed code are member-only UI on
                  /pro/profile (PublicPageCard), so those tools go away; a
                  widget already embedded on the pro's own site keeps
                  rendering, which is why this says the kit and not the
                  widget. The sentence itself is built on the server, next to
                  the dates it names. */}
              <ConfirmSubmit
                subtle
                label="Cancel membership"
                note={cancelNote}
                yesLabel="Yes, cancel my membership"
              />
            </form>
          </div>
        )}
      </div>
      <div className="card">
        <p className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
          Your member perks
        </p>
        {/* Streaming fix, not a layout change: see PerksList.tsx's header
            comment and scratchpad/debug-DBG3.md. */}
        <PerksList perks={PERKS} variant="member" />
        {/* Every perk above carries a green check, which is true for all but
            two while the trial runs: the wallet credit needs a paid invoice
            and the deposit match needs an "active" row (see creditDepositSession
            in the Stripe webhook). Name both here rather than leave a check
            standing next to money that will not move yet. */}
        {trialing && (
          <p className="mt-3 border-t border-stone-100 pt-3 text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">
            While your free trial runs, the $10 lead credit and the{" "}
            +{PRO_DEPOSIT_BOOST_PTS}% deposit match are the two that are still
            waiting: both start when the trial converts and your first payment
            goes through. Deposits before then earn the normal tier bonus.
          </p>
        )}
      </div>
      <p className="text-center text-xs text-stone-500 dark:text-stone-400">
        Membership never changes which jobs you can see or apply to. Leads
        stay pay-per-apply for everyone.
      </p>
    </div>
  );
}

// A membership Stripe still considers live but that hasProPlan() reads as
// not-entitled (past_due, unpaid, incomplete). ROSCA's "simple mechanisms to
// stop recurring charges" (15 U.S.C. 8403(3)) applies whether or not the perks
// are switched on, so this screen exists to keep a way out on the page.
export function PlusPastDue({
  manageAction,
  cancelAction,
}: {
  manageAction: FormAction;
  cancelAction: FormAction;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Hearth Pro
        </h1>
      </div>
      <div className="card space-y-4 text-center">
        <p className="text-sm text-stone-600 dark:text-stone-300">
          We couldn&apos;t take your last Hearth Pro payment, so your member
          perks are paused while your bank and Stripe sort it out. Your lead
          access is unaffected either way. Update your payment method to
          switch the perks back on, or cancel so nothing further is charged.
        </p>
        <form action={manageAction}>
          <button className="btn-primary">Update payment method</button>
        </form>
        <div className="border-t border-stone-100 pt-4 dark:border-white/10">
          <form action={cancelAction}>
            <ConfirmSubmit
              subtle
              label="Cancel membership"
              note="Your membership stops renewing and nothing further is charged. Your lead access stays exactly the same. Cancel?"
              yesLabel="Yes, cancel my membership"
            />
          </form>
        </div>
      </div>
      <p className="text-center text-xs text-stone-500 dark:text-stone-400">
        Questions about billing?{" "}
        <Link href="/pro/billing" className="hover:underline">
          Visit billing
        </Link>
        .
      </p>
    </div>
  );
}

// The pitch, for everyone who is not a member.
export function PlusPitch({
  reasonCopy,
  trialEligible,
}: {
  /** The ?reason= banner copy, already looked up on the server. */
  reasonCopy: string | null;
  trialEligible: boolean;
}) {
  return (
    // Wider than the other branches of this page: the pricing block below is
    // three real columns (no membership, Yearly, Monthly), and max-w-2xl
    // squeezes them to the point of wrapping every price line.
    //
    // PHONE ORDER (2026-08-30, CEO pass item B). On a phone this page used to
    // read hero -> "never changes" banner -> six perk cards -> the trial
    // button, so the offer itself sat below a screen or two of preamble - the
    // same "leads with perks, not the offer" problem the homeowner /plus page
    // had. flex+order reorders the SAME children per breakpoint rather than
    // rendering two copies of ProPlanToggle (a client component with its own
    // forms and radio group; a second copy would double both). gap-8 replaces
    // space-y-8 because the space-y selector keys off DOM adjacency, which
    // does not track the visual order the `order-*` classes create. Every
    // child carries both a max-sm: and an sm: order so desktop keeps today's
    // exact order and phone gets the new one.
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {reasonCopy && (
        <div className="order-1 card border-hearth-200 bg-hearth-50 text-center dark:border-hearth-500/30 dark:bg-hearth-500/15">
          <p className="text-sm text-hearth-800 dark:text-hearth-200">
            {reasonCopy}
          </p>
        </div>
      )}

      <div className="order-2 text-center">
        <h1 className="text-3xl font-semibold text-stone-900 dark:text-stone-100">
          Run your business, not your admin
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
          Hearth Pro is a toolkit for the business side: faster alerts, more
          credit on every deposit, and an AI back office that handles the
          paperwork.
        </p>
        {/* No CTA button up here any more. This used to duplicate the trial
            button in ProPlanToggle below with a second, differently-worded
            button ("Try Pro free..." here vs. "Start N free days" there) plus
            its own restatement of the price and renewal terms - four buttons
            and two phrasings on one page before counting the plan cards.
            ProPlanToggle's own top trial button now states the same facts
            (free days, price after, cancel before it ends) in the one place a
            reader is actually about to act on them; repeating it here was the
            clutter, matching the homeowner /plus page's own PlanToggle. */}
      </div>

      {/* The offer itself, directly under the H1 on a phone: max-sm:order-3
          puts it right after the heading, before any of the preamble below.
          Desktop keeps its old spot, sm:order-6. */}
      <div className="max-sm:order-3 sm:order-6">
        <ProPlanToggle trialEligible={trialEligible} />
      </div>

      {/* The straight answer, up front on desktop; on a phone this shrinks to
          one short line and moves under the button (max-sm:order-4, right
          after the ProPlanToggle block above) instead of standing between the
          H1 and the offer. */}
      <div className="rounded-xl border border-stone-200 bg-stone-50 text-center text-stone-600 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 max-sm:order-4 max-sm:p-2 max-sm:text-xs sm:order-3 sm:p-4 sm:text-sm">
        <span className="sm:hidden">
          Membership never changes which jobs you can see or apply to.
        </span>
        <span className="hidden sm:inline">
          Membership never changes which jobs you can see or apply to. Every job
          stays open to every pro, pay per application, member or not.
        </span>
      </div>

      {/* The perks grid above leads with the two perks that money is attached
          to, but on the free trial those two are held back: the wallet credit
          needs a paid invoice and the deposit match needs an "active" row (see
          creditDepositSession in the Stripe webhook). A pre-purchase visitor
          about to start a trial has no subscription row yet, so this must show
          for a trial-eligible visitor as well, not only a "trialing" row. A
          returning member (trialEligible false) starts paying right away, so
          their perks are on from day one and they don't see this. */}
      {trialEligible && (
        <p className="order-5 text-center text-xs text-stone-500 dark:text-stone-400">
          Two of these start when your free trial converts and your first
          payment goes through: your first $10 of lead credit, and your{" "}
          +{PRO_DEPOSIT_BOOST_PTS}% deposit match. During the trial, deposits
          earn the normal tier bonus and every other perk is already on.
        </p>
      )}

      {/* Streaming fix, not a layout change: see PerksList.tsx's header
          comment and scratchpad/debug-DBG3.md - this used to be PERKS.map()
          rendered inline here, six description-heavy cards sitting near the
          tail of this branch's Server Component row. Perk cards go LAST on a
          phone (max-sm:order-6): the offer above already made its case. */}
      <div className="max-sm:order-6 sm:order-4">
        <PerksList perks={PERKS} variant="grid" />
      </div>

      <p className="order-7 text-center text-xs text-stone-500 dark:text-stone-400">
        Questions about billing?{" "}
        <Link href="/pro/billing" className="hover:underline">
          Visit billing
        </Link>
        .
      </p>
    </div>
  );
}
