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
// Moving Activity into its own client module (ActivityList.tsx) fixed the
// middle of the page but not the end of it: measured live on 2026-08-30 the
// page row still deferred ONE element, <ActivityList> itself, because the
// intro copy, the balances and the deposit section ahead of it had already
// spent the budget by byte ~4200. There is no "last element" fix for that -
// whatever renders last takes the deferral - so the whole body moves in here
// and the page's own row becomes a single client reference with plain data.
//
// Nothing here is newly interactive and nothing is newly computed on the
// client. Breadcrumbs, ProTrialNudge, DepositForm, FadingBanner,
// ProUpgradeCta and ActivityList were already components of their own; the
// rest is static markup rendered from props. Everything that reads the clock
// or the locale - each activity row's timestamp, the dollar strings - is still
// resolved on the server and arrives as a finished string, so hydration cannot
// disagree with SSR about it.

import Link from "next/link";
import { PRO_DEPOSIT_BOOST_PTS } from "@/lib/constants";
import { AGING_LEAD_TIERS } from "@/lib/leadPricing";
import DepositForm from "./DepositForm";
import ActivityList, { type ActivityRow } from "./ActivityList";
import FadingBanner from "@/components/FadingBanner";
import ProUpgradeCta from "@/components/pro/ProUpgradeCta";
import ProTrialNudge from "@/components/pro/ProTrialNudge";
import Breadcrumbs from "@/components/Breadcrumbs";

export type DepositTier = { min_cents: number; max_cents: number | null; bonus_pct: number };

export default function BillingView({
  userId,
  trialEligible,
  proMember,
  boostActive,
  cashLabel,
  bonusLabel,
  tiers,
  need,
  needStr,
  needCategory,
  paid,
  canceled,
  activity,
}: {
  userId: string | null;
  trialEligible: boolean;
  proMember: boolean;
  /** True only for a paid, "active" membership: the trial does not earn it. */
  boostActive: boolean;
  /** Wallet balances, already formatted as dollar strings on the server. */
  cashLabel: string;
  bonusLabel: string;
  tiers: DepositTier[];
  /** From ?need=: how much more the wallet needs for one specific job. */
  need: number | null;
  needStr: string | null;
  needCategory: string | null;
  paid: boolean;
  canceled: boolean;
  activity: ActivityRow[];
}) {
  // Ascending by days so the aging bullet reads "15% after 3 days, 30% after
  // 7" rather than the module's own newest-first order. Pure arithmetic over a
  // static table, so it reads the same on both sides of hydration.
  const agingTiers = [...AGING_LEAD_TIERS].sort((a, b) => a.days - b.days);

  return (
    <div className="space-y-8">
      {/* This was a pro-side page with no trail; the ProNav profile menu
          label ("Billing") is reused verbatim so the crumb and the menu
          never disagree. */}
      <Breadcrumbs
        items={[{ label: "Home", href: "/pro" }, { label: "Billing" }]}
      />
      {/* First visit to billing, then every tenth after it: a pro standing at
          the wallet is the one moment the trial is actually relevant. Renders
          nothing at all for a member, or for a pro who already used the trial
          (trialEligible is the same "no pro-side subscriptions row at all"
          signal the upgrade card below uses, since that row outlives a
          cancellation). The visit counting is per user in localStorage. */}
      <ProTrialNudge eligible={trialEligible} userId={userId} />

      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Billing</h1>
        {/* No per-trade price list here any more. A wall of "Light jobs $X /
            Skilled trades $Y / Big-ticket $Z" was the first thing a pro saw on
            the page they open to add money, and it read as a bill before they
            had won anything. The numbers still exist where they matter: the
            exact fee for the job in hand is printed on the apply button and
            again on its confirm step (src/app/pro/ApplyJobButton.tsx: "Apply .
            $X", "Applying charges the $X lead fee", "Confirm and pay $X"), so
            nobody is ever charged an amount they were not shown, and the full
            tier list lives on the help page linked below. */}
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          You pay per lead you apply to, and you see the exact price before you
          apply. Ghost protection and the first-application guarantee can
          return some of that as wallet credit; see Activity below for how each
          one works.{" "}
          <Link
            href="/pro/help#lead-pricing"
            className="font-medium text-hearth-700 underline dark:text-hearth-300"
          >
            How lead pricing works
          </Link>
        </p>
        <ul className="mt-2 space-y-1 text-xs text-stone-500 dark:text-stone-400">
          <li>
            Jobs that sit unclaimed get cheaper: {agingTiers[0].off}% off
            after {agingTiers[0].days} days, {agingTiers[1].off}% off after{" "}
            {agingTiers[1].days}. The discounted price is what your wallet is
            charged.
          </li>
        </ul>
      </div>

      {need !== null && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
          You need {needStr} more to apply to that{" "}
          {needCategory ? `${needCategory} ` : ""}job.
        </div>
      )}

      {/* A calm confirmation only: no celebration effect here, this is just
          spending money. */}
      {paid && (
        <FadingBanner className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300">
          Payment received. Your wallet has been credited.
        </FadingBanner>
      )}
      {canceled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
          Checkout canceled. No charge was made.
        </div>
      )}

      {/* Balances. Side by side on a phone too (not just from sm up): the
          owner's ask was "add credit" reachable with no scroll, and a
          stacked pair of cards alone was pushing the deposit buttons off the
          first screen. Tighter padding and a smaller number below sm buy
          back the height the second row used to cost; the label stays full
          size since the number, not the caption, is what the row is for.
          CR3#10: gap-3 -> gap-2 and p-3 -> p-2.5 on phone tighten the rhythm
          further, closing the rest of the gap between here and "Add credit"
          with no scroll. */}
      <section className="grid gap-4 max-sm:grid-cols-2 max-sm:gap-2 sm:grid-cols-2">
        <div className="card-hero max-sm:p-2.5">
          <p className="stat-label text-hearth-800 dark:text-hearth-400">Lead credit</p>
          <p className="stat-number mt-1 text-4xl max-sm:text-xl text-hearth-900 dark:text-hearth-200">
            {cashLabel}
          </p>
          <p className="mt-1 text-xs text-hearth-700">Never expires.</p>
        </div>
        <div className="card border-amber-200 bg-amber-50 max-sm:p-2.5 dark:border-amber-500/30 dark:bg-amber-500/15">
          <p className="stat-label text-amber-800 dark:text-amber-400">Bonus credit</p>
          <p className="stat-number mt-1 text-2xl max-sm:text-xl text-amber-900 dark:text-amber-300">
            {bonusLabel}
          </p>
          <p className="mt-1 text-xs text-amber-700">
            Promotional · expires 60 days after each grant.
          </p>
        </div>
      </section>

      {/* Deposit */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Add credit</h2>
        <DepositForm
          tiers={tiers as any}
          need={need ?? undefined}
          boostPts={boostActive ? PRO_DEPOSIT_BOOST_PTS : 0}
          // Only a NON-member is forgoing the match. A member mid-trial is
          // having it held back, which the caveat line below explains in its
          // own words; telling them they are losing it would be wrong.
          forgoneBoostPts={proMember ? 0 : PRO_DEPOSIT_BOOST_PTS}
        />
        {proMember && !boostActive ? (
          // Trialing member: the form above is deliberately showing the plain
          // tier bonus, because that is what this deposit will actually earn.
          // Say when the match starts rather than let the number look broken.
          <div className="rounded-xl border border-hearth-200 bg-hearth-50 p-3 text-xs text-hearth-800 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
            <span className="font-semibold">
              Your +{PRO_DEPOSIT_BOOST_PTS}% deposit match and your $10 monthly
              lead credit start when your free trial converts.
            </span>{" "}
            Deposits you make during the trial earn the normal tier bonus shown
            above. Every other Pro perk is already on.
          </div>
        ) : proMember ? (
          <div className="rounded-xl border border-hearth-200 bg-hearth-50 p-3 text-xs text-hearth-800 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
            <span className="font-semibold">Pro member bonus applied:</span>{" "}
            every tier below earns +{PRO_DEPOSIT_BOOST_PTS} pts
            {tiers.length > 0 && (
              <>
                {" "}
                (
                {tiers
                  .map(
                    (t) =>
                      `$${Math.round(t.min_cents / 100)}+ earns ${
                        t.bonus_pct + PRO_DEPOSIT_BOOST_PTS
                      }%`
                  )
                  .join(", ")}
                )
              </>
            )}
            .
          </div>
        ) : (
          // Upgrade card on the add-funds surface: the deposit boost is the
          // one Pro perk that pays off right here, so it is worth its own
          // card next to the form. The button leads with the free trial only
          // when this pro will actually get one; /pro/plus still owns the
          // full auto-renewal disclosure and the checkout itself.
          <div className="rounded-xl border border-hearth-200 bg-hearth-50 p-4 dark:border-hearth-500/30 dark:bg-hearth-500/15">
            <p className="text-sm font-semibold text-hearth-800 dark:text-hearth-200">
              Pro members get +{PRO_DEPOSIT_BOOST_PTS}% on every deposit
            </p>
            <p className="mt-1 text-sm text-hearth-700 dark:text-hearth-300">
              Same money in, more lead credit out. Membership never changes
              which jobs you can see or apply to.
            </p>
            {/* This card headlines the deposit match right next to the deposit
                form, so a trial buyer must be told it is the one perk held back
                until the trial converts (the webhook applies it only against an
                "active" row, see boostActive above). A returning member
                (trialEligible false) starts paying right away, so their match
                is live from day one and they don't see this line. */}
            {trialEligible && (
              <p className="mt-1 text-xs text-hearth-700 dark:text-hearth-300">
                Your +{PRO_DEPOSIT_BOOST_PTS}% match starts when your free trial
                converts and your first payment goes through. Deposits during
                the trial earn the normal tier bonus.
              </p>
            )}
            <ProUpgradeCta
              trialEligible={trialEligible}
              className="btn-primary mt-3 inline-block"
              sublineClassName="mt-2 text-xs text-hearth-700 dark:text-hearth-300"
            />
          </div>
        )}
      </section>

      {/* Activity, still its own component: the rows arrive already formatted
          from the server. See the comment at the top of ActivityList.tsx. */}
      <ActivityList rows={activity} />
    </div>
  );
}
