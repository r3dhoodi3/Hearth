import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentContractor } from "@/lib/contractor";
import { createClient } from "@/lib/supabase/server";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import {
  labelFor,
  JOB_CATEGORIES,
  PRO_DEPOSIT_BOOST_PTS,
} from "@/lib/constants";
import {
  GHOST_PROTECTION_GUARANTEE,
  FIRST_APPLICATION_GUARANTEE,
  CREDIT_NOT_CASH_LINE,
} from "@/lib/guaranteeCopy";
import { AGING_LEAD_TIERS } from "@/lib/leadPricing";
import DepositForm from "./DepositForm";
import FadingBanner from "@/components/FadingBanner";
import ProUpgradeCta from "@/components/pro/ProUpgradeCta";
import ProTrialNudge from "@/components/pro/ProTrialNudge";
import Breadcrumbs from "@/components/Breadcrumbs";

function dollars(cents: number | string | null) {
  const v = Number(cents ?? 0);
  return `$${((Number.isFinite(v) ? v : 0) / 100).toFixed(2)}`;
}

// One vocabulary for the whole apply-fee lifecycle, so a charge, its
// ghost-protection return, and a post-return re-charge all clearly describe
// the same fee. Every return is wallet credit, never cash, so the labels say
// credit.
const TX_LABEL: Record<string, string> = {
  deposit: "Deposit",
  bonus_grant: "Bonus credit",
  lead_charge: "Lead unlocked",
  apply_fee: "Apply fee",
  bonus_expiry: "Bonus expired",
  adjustment: "Adjustment",
  ghost_refund: "Apply fee returned as credit",
  ghost_recharge: "Apply fee re-charged: homeowner chose you after the credit",
  ghost_recharge_waived: "Re-charge waived",
  apply_credit_back: "Apply fee returned as credit: homeowner picked another pro",
  first_apply_guarantee: "First application guarantee: fee returned as credit",
  winback_credit: "Welcome-back credit",
  direct_unlock: "Direct request unlocked",
  membership_credit: "Membership credit",
  membership_credit_reversal: "Membership credit reversed",
  referral_reward: "Referral credit",
  chargeback_reversal: "Deposit reversed after a chargeback",
  // The one-time thank-you for sending product feedback (migration 0144). Not
  // a rating and not a review: see src/lib/proFeedback.ts.
  feedback_credit: "Feedback thank-you credit",
};

// Never show a raw transaction type like "apply_fee": mapped label first,
// humanized underscores as the fallback for anything new.
function txLabel(type: string | null | undefined): string {
  if (!type) return "Activity";
  return TX_LABEL[type] ?? type.replace(/_/g, " ");
}

export default async function ProBillingPage(props: {
  searchParams: Promise<{
    paid?: string;
    canceled?: string;
    need?: string;
    category?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();

  // Everything this page needs beyond the contractor row itself, in ONE wave.
  // These were five sequential awaits, and nothing in the list depends on
  // anything else in it: the two subscription reads share a request-cached
  // query, the wallet and the application history key off the contractor we
  // already have, and the deposit tiers are a static table. Serially that was
  // five round trips stacked in front of first byte; concurrently it is one.
  // The only genuinely dependent read (wallet transactions, which needs the
  // wallet id) stays behind in its own wave below.
  const [proMember, proSub, { data: wallet }, { data: tiers }] =
    await Promise.all([
      // Pro members earn extra points on every deposit bonus (display only
      // here; the webhook applies the real boost when the payment lands).
      hasProPlan(),
      // The Pro-side subscription row itself, for the upgrade card below the
      // deposit form and for the boost gate just below. The free trial is for
      // brand-new members only and the row outlives a cancellation, so a pro
      // who churned and came back must never be offered a trial they will not
      // get. Free to ask for alongside hasProPlan(): both resolve from the
      // same request-cached subscription query, so running them together
      // dedupes to a single read rather than racing into two.
      getProSubscription(),
      supabase
        .from("wallets")
        .select("id, cash_balance_cents, bonus_balance_cents")
        .eq("contractor_id", contractor.id)
        .maybeSingle(),
      supabase
        .from("deposit_tiers")
        .select("min_cents, max_cents, bonus_pct")
        .order("min_cents", { ascending: true }),
    ]);

  const trialEligible = !proMember && !proSub;

  // The deposit match is the one perk that does NOT switch on during the free
  // trial. The Stripe webhook grants it only against an "active" row (see the
  // activePro check in creditDepositSession), because a boost is real money and
  // a trial has not paid for it yet. So a trialing member has to see the plain
  // tier bonus and be told when the match starts, never a boosted number their
  // deposit will not actually earn. hasProPlan() is true for both statuses, so
  // it cannot be the signal here.
  const boostActive = proMember && proSub?.status === "active";

  const cash = Number((wallet as any)?.cash_balance_cents ?? 0);
  const bonus = Number((wallet as any)?.bonus_balance_cents ?? 0);

  let txns: any[] = [];
  if ((wallet as any)?.id) {
    const { data } = await supabase
      .from("wallet_transactions")
      .select("*")
      .eq("wallet_id", (wallet as any).id)
      .order("created_at", { ascending: false })
      .limit(50);
    txns = data ?? [];
  }

  // Arrived from an "Add funds to apply" link: how much more the wallet needs
  // for that specific job. Drives the banner and the preselected deposit.
  const needRaw = Number(searchParams.need);
  const need = Number.isFinite(needRaw) && needRaw > 0 ? needRaw : null;
  const needStr =
    need !== null
      ? Number.isInteger(need)
        ? `$${need}`
        : `$${need.toFixed(2)}`
      : null;
  const needCategory = searchParams.category
    ? labelFor(JOB_CATEGORIES, searchParams.category)
    : null;

  // Ascending by days so the aging bullet reads "15% after 3 days, 30% after
  // 7" rather than the module's own newest-first order.
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
      <ProTrialNudge
        eligible={trialEligible}
        userId={contractor.user_id ?? null}
      />

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
      {searchParams.paid && (
        <FadingBanner className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300">
          Payment received. Your wallet has been credited.
        </FadingBanner>
      )}
      {searchParams.canceled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
          Checkout canceled. No charge was made.
        </div>
      )}

      {/* Balances */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="card-hero">
          <p className="stat-label text-hearth-800 dark:text-hearth-400">Lead credit</p>
          <p className="stat-number mt-1 text-4xl text-hearth-900 dark:text-hearth-200">
            {dollars(cash)}
          </p>
          <p className="mt-1 text-xs text-hearth-700">Never expires.</p>
        </div>
        <div className="card border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/15">
          <p className="stat-label text-amber-800 dark:text-amber-400">Bonus credit</p>
          <p className="stat-number mt-1 text-2xl text-amber-900 dark:text-amber-300">
            {dollars(bonus)}
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
          tiers={(tiers as any) ?? []}
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
            {((tiers as any) ?? []).length > 0 && (
              <>
                {" "}
                (
                {((tiers as any) as Array<{
                  min_cents: number;
                  bonus_pct: number;
                }>)
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

      {/* Activity */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Activity</h2>
        {txns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:text-stone-400">
            No activity yet. Add credit to get started.
          </p>
        ) : (
          <ul className="space-y-2">
            {txns.map((t) => {
              const net = Number(t.cash_delta_cents) + Number(t.bonus_delta_cents);
              const positive = net >= 0;
              return (
                <li
                  key={t.id}
                  className="card flex items-center justify-between gap-3"
                >
                  <div>
                    <span className="font-medium text-stone-900 dark:text-stone-100">
                      {txLabel(t.type)}
                    </span>
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      {new Date(t.created_at).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={`font-semibold [font-variant-numeric:tabular-nums] ${
                      positive ? "text-green-600 dark:text-green-400" : "text-stone-700 dark:text-stone-300"
                    }`}
                  >
                    {positive ? "+" : "−"}
                    {dollars(Math.abs(net))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {txns.length > 0 && (
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Ghost protection: {GHOST_PROTECTION_GUARANTEE} If they come back
            and choose you after that, the same fee is re-charged. Separately,
            the first-application guarantee: {FIRST_APPLICATION_GUARANTEE}{" "}
            {CREDIT_NOT_CASH_LINE}
          </p>
        )}
      </section>
    </div>
  );
}
