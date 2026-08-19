import Link from "next/link";
import { redirect } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { Gift, DollarSign, Bot, Globe, BarChart3, Zap } from "lucide-react";
import { getCurrentContractor } from "@/lib/contractor";
import {
  hasProPlan,
  getProSubscription,
  getBillingOutlook,
} from "@/lib/subscription";
import {
  PRO_PLAN,
  PRO_DEPOSIT_BOOST_PTS,
  COLD_START_FREE_ALERTS,
} from "@/lib/constants";
import {
  manageProBillingAction,
  cancelProMembershipAction,
  resumeProMembershipAction,
} from "./actions";
import ProPlanToggle from "./ProPlanToggle";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";

// The perk lineup, used by both the pitch and the welcome screen. Membership
// is perks only: it never changes which jobs a pro can see or apply to.
// Ordered exclusive economics first (credit, deposit boost, AI back office);
// alerts sit last while COLD_START_FREE_ALERTS makes them free for everyone.
const PERKS: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Gift,
    title: "$10 lead credit every month",
    // Mirrors grant_membership_credit in the Stripe webhook: monthly grants
    // are $10 with a 60-day expiry, yearly is $120 up front with a 400-day
    // expiry (it outlives the year). Keep this copy in sync with those terms.
    body: "Each monthly billing cycle drops $10 of bonus lead credit into your wallet, good for 60 days from the day it lands. On the yearly plan the whole $120 lands up front and stays spendable for your entire year.",
  },
  {
    icon: DollarSign,
    title: `+${PRO_DEPOSIT_BOOST_PTS}% on every deposit`,
    body: `Every wallet deposit earns an extra ${PRO_DEPOSIT_BOOST_PTS} percentage points of bonus credit, on top of the regular tier bonus.`,
  },
  {
    icon: Bot,
    title: "AI back office",
    // /api/pro-tools ships five tools (estimate, invoice, followup,
    // review_response, overdue); list all five here so this perk isn't
    // undersold. The 250 mirrors DAILY_LIMIT_PLUS in src/lib/aiUsage.ts: the
    // shared per-user daily cap on every AI route. Keep both in sync.
    body: "Draft estimates, invoices, follow-up messages, review responses, and overdue-invoice reminders in seconds, up to 250 drafts a day, so evenings go back to being evenings.",
  },
  {
    icon: Globe,
    title: "A richer public page",
    body: "Every pro already gets a public page with their services, reviews, and contact info. Pro adds your logo, work photos, and an about section so it looks fully yours. Send one link instead of ten screenshots.",
  },
  {
    icon: BarChart3,
    title: "Win-rate analytics",
    body: "See which jobs you win, what each lead really costs, and where your money works hardest.",
  },
  {
    icon: Zap,
    title: "Instant job alerts",
    // COLD START: while COLD_START_FREE_ALERTS is on, every pro gets these
    // alerts, so the perk says so honestly. The parenthetical drops when the
    // flag flips back to members-only.
    body:
      "The moment a job posts in your trades and area, it hits your email and your phone. Be the first name the homeowner sees." +
      (COLD_START_FREE_ALERTS
        ? " (Included for every pro right now while Hearth is new.)"
        : ""),
  },
];

export default async function ProPlusPage({
  searchParams,
}: {
  searchParams: { welcome?: string };
}) {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  // The Pro-side row specifically: with two memberships per account possible
  // (0036), the homeowner Plus row must never drive this page's billing UI.
  const [member, sub] = await Promise.all([hasProPlan(), getProSubscription()]);

  // One-time confirmation right after checkout. Shown off the ?welcome=1 flag
  // so it appears even if the Stripe webhook hasn't synced the subscription yet.
  if (searchParams.welcome === "1") {
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
        <ul className="mx-auto max-w-md space-y-2 text-left">
          {PERKS.map((p) => (
            <li key={p.title} className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300">
              <p.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium text-stone-900 dark:text-stone-100">{p.title}.</span>{" "}
                {p.body}
              </span>
            </li>
          ))}
        </ul>
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
        {(!sub || sub.status === "trialing") && (
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
          {sub?.status && sub.status !== "canceled" && sub.plan ? (
            <AutoRenewalTerms
              plan={sub.plan === "pro_yearly" ? "pro_yearly" : "pro_monthly"}
              introEligible={sub.status === "trialing"}
              variant="acknowledgment"
            />
          ) : (
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-left dark:border-white/10 dark:bg-stone-900">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Your Hearth Pro renewal terms
              </p>
              <p className="mt-2 text-xs text-stone-600 dark:text-stone-300">
                Hearth Pro renews automatically until you cancel. Your
                confirmation email lists the exact amount and the renewal
                terms; refresh this page in a moment to see your billing dates.
                Cancel anytime on this page using the &quot;Cancel
                membership&quot; button. If you started on a free trial, cancel
                before it ends and you will not be charged; otherwise
                cancelling takes effect at the end of the period you have
                already paid for. There is nothing to call or email.
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-3">
          <Link href="/pro" className="btn-primary">
            Back to my leads
          </Link>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            If a perk still looks off, give it a minute to sync, then refresh.
          </p>
        </div>
      </div>
    );
  }

  if (member) {
    const { cancelsAt } = await getBillingOutlook(sub);
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
            {sub?.plan === "pro_yearly" ? "Yearly" : "Monthly"} plan
            {sub?.current_period_end
              ? sub.status === "trialing"
                ? ` · free trial, first charge ${new Date(sub.current_period_end).toLocaleDateString()}`
                : ` · renews ${new Date(sub.current_period_end).toLocaleDateString()}`
              : ""}
          </p>
          <form action={manageProBillingAction}>
            <button className="btn-secondary">Manage billing</button>
          </form>
          {sub?.stripe_subscription_id && cancelsAt && (
            <div className="space-y-2 border-t border-stone-100 pt-4 dark:border-white/10">
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Your membership ends on {cancelsAt.toLocaleDateString()}. You
                keep every perk until then, and your lead access never changes.
              </p>
              <form action={resumeProMembershipAction}>
                <button className="btn-secondary">Keep my membership</button>
              </form>
            </div>
          )}
          {sub?.stripe_subscription_id && !cancelsAt && (
            <div className="border-t border-stone-100 pt-4 dark:border-white/10">
              <form action={cancelProMembershipAction}>
                {/* Cancelling during the trial is the case the law cares most
                    about, and "the time you've paid for" would be wrong for it:
                    nothing has been paid yet, and the point is that nothing
                    will be. */}
                <ConfirmSubmit
                  subtle
                  label="Cancel membership"
                  note={
                    sub.status === "trialing"
                      ? "Your free trial ends and you won't be charged anything. You keep every perk until the trial's last day. Your lead access stays exactly the same. Cancel?"
                      : "You'd keep every perk through the time you've paid for, and it just won't renew. Your lead access stays exactly the same. Cancel?"
                  }
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
          <ul className="space-y-2">
            {PERKS.map((p) => (
              <li
                key={p.title}
                className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"
              >
                <span className="mt-0.5 font-bold text-green-600 dark:text-green-400">✓</span>
                <span>
                  <span className="font-medium text-stone-900 dark:text-stone-100">{p.title}.</span>{" "}
                  {p.body}
                </span>
              </li>
            ))}
          </ul>
          {/* Every perk above carries a green check, which is true for all but
              two while the trial runs: the wallet credit needs a paid invoice
              and the deposit match needs an "active" row (see creditDepositSession
              in the Stripe webhook). Name both here rather than leave a check
              standing next to money that will not move yet. */}
          {sub?.status === "trialing" && (
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

  // Same reasoning as the homeowner /plus page: a membership Stripe still
  // considers live but that hasProPlan() reads as not-entitled (past_due,
  // unpaid, incomplete) must not fall through to the pitch below, or someone
  // whose card is actively being retried has no in-app way to stop the
  // charges. ROSCA's "simple mechanisms to stop recurring charges"
  // (15 U.S.C. 8403(3)) applies whether or not the perks are switched on.
  if (sub?.stripe_subscription_id && sub.status !== "canceled") {
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
          <form action={manageProBillingAction}>
            <button className="btn-primary">Update payment method</button>
          </form>
          <div className="border-t border-stone-100 pt-4 dark:border-white/10">
            <form action={cancelProMembershipAction}>
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

  // Mirrors startProCheckoutAction's own trial gate exactly: the free trial is
  // for brand-new members, and the Pro-side row survives cancellation (it lands
  // on "canceled", it is not deleted), so a member who churned and came back
  // must not be shown trial copy for a trial they will not get.
  const trialEligible = !sub;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold text-stone-900 dark:text-stone-100">
          Run your business, not your admin
        </h1>
        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
          Hearth Pro is a toolkit for the business side: faster alerts, more
          credit on every deposit, and an AI back office that handles the
          paperwork.
        </p>
        <div className="mt-5">
          {/* Trial-first: the button leads with the free trial and the price is
              the follow-through line under it, never the lead. `trialEligible`
              is the same no-existing-Pro-row signal startProCheckoutAction
              uses, so a returning member sees the plain price instead. */}
          <a href="#pricing" className="btn-primary">
            {trialEligible
              ? `Try Pro free for ${PRO_PLAN.trialDays} days`
              : "Start my Pro membership"}
          </a>
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
            {trialEligible
              ? `Then $${PRO_PLAN.monthly}/month. Auto-renews. Cancel anytime before the trial ends and you won't be charged. Or $${PRO_PLAN.yearly}/year, save $${Math.round(PRO_PLAN.monthly * 12 - PRO_PLAN.yearly)} vs monthly.`
              : `$${PRO_PLAN.monthly}/month, auto-renews until you cancel. Or $${PRO_PLAN.yearly}/year, save $${Math.round(PRO_PLAN.monthly * 12 - PRO_PLAN.yearly)} vs monthly.`}
          </p>
        </div>
      </div>

      {/* The straight answer, up front: membership never touches lead access. */}
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 text-center text-sm text-stone-600 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300">
        Membership never changes which jobs you can see or apply to. Every job
        stays open to every pro, pay per application, member or not.
      </div>

      <section className="grid gap-4 sm:grid-cols-2">
        {PERKS.map((p) => (
          <div key={p.title} className="card">
            <div className="icon-chip">
              <p.icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 className="mt-2 font-semibold text-stone-900 dark:text-stone-100">{p.title}</h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{p.body}</p>
          </div>
        ))}
      </section>

      {/* The perks grid above leads with the two perks that money is attached
          to, but on the free trial those two are held back: the wallet credit
          needs a paid invoice and the deposit match needs an "active" row (see
          creditDepositSession in the Stripe webhook). A pre-purchase visitor
          about to start a trial has no subscription row yet, so this must show
          for a trial-eligible visitor as well, not only a "trialing" row. A
          returning member (trialEligible false) starts paying right away, so
          their perks are on from day one and they don't see this. */}
      {trialEligible && (
        <p className="text-center text-xs text-stone-500 dark:text-stone-400">
          Two of these start when your free trial converts and your first
          payment goes through: your first $10 of lead credit, and your{" "}
          +{PRO_DEPOSIT_BOOST_PTS}% deposit match. During the trial, deposits
          earn the normal tier bonus and every other perk is already on.
        </p>
      )}

      <ProPlanToggle trialEligible={trialEligible} />

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
