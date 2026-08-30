import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { createClient } from "@/lib/supabase/server";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { labelFor, JOB_CATEGORIES } from "@/lib/constants";
// The body is one client component. That is a streaming fix, not a behaviour
// change: moving Activity out fixed the middle of the page, but the page's own
// Flight row still deferred whatever rendered LAST - measured live as one
// deferral on <ActivityList> itself. See the comment at the top of
// BillingView.tsx.
import BillingView from "./BillingView";

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

  return (
    <BillingView
      userId={contractor.user_id ?? null}
      trialEligible={trialEligible}
      proMember={proMember}
      boostActive={boostActive}
      cashLabel={dollars(cash)}
      bonusLabel={dollars(bonus)}
      tiers={((tiers as any) ?? []) as any}
      need={need}
      needStr={needStr}
      needCategory={needCategory}
      paid={Boolean(searchParams.paid)}
      canceled={Boolean(searchParams.canceled)}
      // Every row is resolved here, on the server: txLabel keeps a raw
      // transaction type off the screen, and toLocaleString has to run on this
      // side or the timestamp would switch to the browser locale and disagree
      // with SSR.
      activity={txns.map((t) => {
        const net = Number(t.cash_delta_cents) + Number(t.bonus_delta_cents);
        return {
          id: t.id as string,
          label: txLabel(t.type),
          when: new Date(t.created_at).toLocaleString(),
          amount: dollars(Math.abs(net)),
          positive: net >= 0,
        };
      })}
    />
  );
}
