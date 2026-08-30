import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import { trialDecision, TRIAL_DECISION_TTL_MS } from "@/lib/risk/decision";
import {
  hasProPlan,
  getProSubscription,
  getBillingOutlook,
} from "@/lib/subscription";
import { PRO_DEPOSIT_BOOST_PTS, PRO_LEAD_DISCOUNT_PCT } from "@/lib/constants";
import { FREE_PRO_DRAFTS } from "@/lib/freeAiTaste";
import {
  manageProBillingAction,
  cancelProMembershipAction,
  resumeProMembershipAction,
} from "./actions";
// Every branch of this page renders through one of these client components.
// That is a streaming fix, not a behaviour change: as server markup the page's
// Flight row ran past React Flight's 3200-byte defer budget and chopped the
// tail of the page (and, inside PerksList's props, the last perk's icon) into
// rows of their own. See the long comment at the top of PlusScreens.tsx.
import {
  PlusWelcome,
  PlusMember,
  PlusPastDue,
  PlusPitch,
} from "./PlusScreens";

// The ?reason= banners. Mirrors the homeowner /plus page: a plain statement of
// what was used up or what is behind the wall, no urgency and no invented
// numbers, so the pitch is specific to the door the pro just tapped. Keys are
// set by the callers: /pro/tools and /api/pro-tools ("tools"), /pro/ask
// ("ask"), the leads board's perk pitch ("leads"), the pro Home nudge
// ("nudge"), the feedback card ("feedback") and the setup checklist's logo
// step ("logo").
const REASON_COPY: Record<string, string> = {
  tools: `You've used your ${FREE_PRO_DRAFTS} free drafts. Hearth Pro includes unlimited drafts: estimates, invoices, follow-ups, review responses, and overdue reminders.`,
  ask: "Hearth Pro raises your daily limit on Ask Hearth, so you can keep asking on the days you actually need it.",
  // The lead discount leads this banner (moved first, 2026-08-30): it is the
  // most direct incentive to subscribe from the exact screen where a pro is
  // about to pay a lead fee. "does not stack with age discounts" is stated in
  // the banner itself, not just on the perks page below, since this is the
  // door a pro reaches by tapping straight off a job card's price line.
  leads: `Membership never changes which jobs you can see or apply to. What it changes is the money around them: ${PRO_LEAD_DISCOUNT_PCT}% off every lead fee (does not stack with age discounts), $10 of lead credit every month, and +${PRO_DEPOSIT_BOOST_PTS}% on every deposit.`,
  nudge: `Hearth Pro: +${PRO_DEPOSIT_BOOST_PTS}% bonus on every deposit and $10 of lead credit every month, once your membership is paid.`,
  feedback:
    "Thanks for the feedback. Hearth Pro is the paid side of the app: the AI back office, win-rate analytics, a richer public page, and credit on every deposit.",
  logo: "Your logo, work photos, and an about section are part of Hearth Pro, so your public page looks like your business rather than a listing.",
};

export default async function ProPlusPage(
  props: {
    searchParams: Promise<{ welcome?: string; reason?: string }>;
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
      <PlusWelcome
        showTrialCaveat={!sub || sub.status === "trialing"}
        renewalPlan={
          sub?.status && sub.status !== "canceled" && sub.plan
            ? sub.plan === "pro_yearly"
              ? "pro_yearly"
              : "pro_monthly"
            : null
        }
        renewalIntroEligible={sub?.status === "trialing"}
      />
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
    //
    // Every date on this screen is formatted HERE, on the server, and travels
    // as a finished string: PlusMember is a client component (streaming fix),
    // and toLocaleDateString on the client could disagree with SSR.
    const endDateLabel = sub?.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString()
      : null;
    // During the trial, current_period_end IS the trial end, so calling it a
    // renewal would hide the thing that actually matters: the date the first
    // charge lands. Say which it is.
    const periodSuffix = sub?.current_period_end
      ? sub.status === "trialing"
        ? ` · free trial, first charge ${new Date(sub.current_period_end).toLocaleDateString()}`
        : ` · renews ${new Date(sub.current_period_end).toLocaleDateString()}`
      : "";
    return (
      <PlusMember
        planLabel={sub?.plan === "pro_yearly" ? "Yearly" : "Monthly"}
        periodSuffix={periodSuffix}
        cancelsAtLabel={
          sub?.stripe_subscription_id && cancelsAt
            ? cancelsAt.toLocaleDateString()
            : null
        }
        // Cancelling during the trial is the case the law cares most about,
        // and "the time you've paid for" would be wrong for it: nothing has
        // been paid yet, and the point is that nothing will be. Null when
        // there is no Stripe subscription to cancel, or when a cancellation is
        // already pending (the resume block above covers that case).
        cancelNote={
          sub?.stripe_subscription_id && !cancelsAt
            ? sub.status === "trialing"
              ? `Your free trial ends${endDateLabel ? ` on ${endDateLabel}` : ""} and you won't be charged anything. Until then nothing changes. After that, your logo, your about section, the share kit and the rating-widget embed code come off your profile, the Before/After labels drop from your project photos, and you can add up to 3 projects instead of unlimited. Your reviews, your rating, your license and background badges, and your lead access never change. Cancel?`
              : `Your membership runs through${endDateLabel ? ` ${endDateLabel}` : " the time you've paid for"} and then stops renewing. After that, your logo, your about section, the share kit and the rating-widget embed code come off your profile, the Before/After labels drop from your project photos, and you can add up to 3 projects instead of unlimited. Your published projects stay up. Your reviews, your rating, your license and background badges, and your lead access never change. Cancel?`
            : null
        }
        trialing={sub?.status === "trialing"}
        manageAction={manageProBillingAction}
        resumeAction={resumeProMembershipAction}
        cancelAction={cancelProMembershipAction}
      />
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
      <PlusPastDue
        manageAction={manageProBillingAction}
        cancelAction={cancelProMembershipAction}
      />
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
        // ...and it may reuse a recent answer rather than re-running the whole
        // fan-out on every refresh of an upsell page. Render path only: the
        // checkout action passes no maxAgeMs, so the decision that actually
        // gates money is always computed fresh. See decision.ts for what is
        // never cached (high, and any refused checkout).
        maxAgeMs: TRIAL_DECISION_TTL_MS,
      })
    : null;
  const trialEligible = !sub && (risk?.allowTrial ?? true);

  // The specific pitch for whatever door sent them here, at the top, exactly
  // like the homeowner /plus page's ?reason= banners. One entry per key, so a
  // pro who tapped a Pro chip on a tile reads about THAT thing rather than the
  // general page. An unknown or absent key renders nothing at all.
  const reasonCopy = REASON_COPY[searchParams.reason ?? ""] ?? null;

  return <PlusPitch reasonCopy={reasonCopy} trialEligible={trialEligible} />;
}
