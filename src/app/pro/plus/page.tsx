import Link from "next/link";
import { redirect } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { Gift, DollarSign, Bot, Globe, BarChart3, Zap } from "lucide-react";
import { getCurrentContractor } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import { trialDecision } from "@/lib/risk/decision";
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
    // alerts, so the perk says so honestly - and says that it is temporary,
    // which "included right now" left the reader to guess at. The
    // parenthetical drops when the flag flips back to members-only.
    body:
      "The moment a job posts in your trades and area, it hits your email and your phone. Be the first name the homeowner sees." +
      (COLD_START_FREE_ALERTS
        ? " (Free for every pro during launch - after launch, instant alerts are members-only.)"
        : ""),
  },
];

export default async function ProPlusPage(
  props: {
    searchParams: Promise<{ welcome?: string }>;
  }
) {
  const searchParams = await props.searchParams;
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
    // The date the membership would actually lapse if cancelled right now.
    // Stripe ends a cancelled subscription at the end of the period already
    // paid for, so current_period_end IS that date (and, while status is
    // "trialing", it is the trial's last day). Null when Stripe has not
    // reported a period end, in which case the cancel note names no date
    // rather than inventing one.
    const endDateLabel = sub?.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString()
      : null;
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
          {/* The date the membership would actually lapse. With no pending
              cancellation yet there is no cancelsAt to read, and Stripe ends
              the subscription at the end of the paid period, so
              current_period_end IS that date (it is also the trial end while
              status is "trialing" - see the note above). Null when Stripe has
              not reported a period end, in which case the copy below falls
              back to naming no date rather than inventing one. */}
          {sub?.stripe_subscription_id && !cancelsAt && (
            <div className="border-t border-stone-100 pt-4 dark:border-white/10">
              <form action={cancelProMembershipAction}>
                {/* Cancelling during the trial is the case the law cares most
                    about, and "the time you've paid for" would be wrong for it:
                    nothing has been paid yet, and the point is that nothing
                    will be.

                    Both notes now name the real end date and the real
                    consequences instead of the vague "every perk". Every
                    clause below was checked against migration 0112's
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
                    widget. */}
                <ConfirmSubmit
                  subtle
                  label="Cancel membership"
                  note={
                    sub.status === "trialing"
                      ? `Your free trial ends${endDateLabel ? ` on ${endDateLabel}` : ""} and you won't be charged anything. Until then nothing changes. After that, your logo, your about section, the share kit and the rating-widget embed code come off your profile, the Before/After labels drop from your project photos, and you can add up to 3 projects instead of unlimited. Your reviews, your rating, your license and background badges, and your lead access never change. Cancel?`
                      : `Your membership runs through${endDateLabel ? ` ${endDateLabel}` : " the time you've paid for"} and then stops renewing. After that, your logo, your about section, the share kit and the rating-widget embed code come off your profile, the Before/After labels drop from your project photos, and you can add up to 3 projects instead of unlimited. Your published projects stay up. Your reviews, your rating, your license and background badges, and your lead access never change. Cancel?`
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
  //
  // The trial-abuse decision is ANDed in for the same reason (src/lib/risk):
  // startProCheckoutAction drops the trial for a medium-risk account, and this
  // flag feeds the auto-renewal disclosure the pro consents to before any
  // billing information is collected. Promising free days that Stripe is not
  // going to give is exactly the mismatch ROSCA and California's Automatic
  // Renewal Law police. Everything else on the page is unchanged.
  //
  // getUser (cached, cookie-read), not getVerifiedUser: this decides COPY, not
  // money. startProCheckoutAction re-verifies and re-runs the same decision
  // before anything is charged.
  const viewer = await getUser();
  const risk = viewer
    ? await trialDecision(viewer.id, {
        accountCreatedAt: viewer.created_at ?? null,
        // A page render is a GET: compute, do not write. The checkout action
        // re-runs the same decision and records it there.
        persist: false,
      })
    : null;
  const trialEligible = !sub && (risk?.allowTrial ?? true);

  return (
    // Wider than the other branches of this page: the pricing block below is
    // three real columns (no membership, Yearly, Monthly), and max-w-2xl
    // squeezes them to the point of wrapping every price line.
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="text-center">
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
