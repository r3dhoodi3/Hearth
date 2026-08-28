import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  ownsPlus,
  getSubscription,
  getBillingOutlook,
  getExtraHomeSlots, isPlusTrialEligible } from "@/lib/subscription";
import { getProperties } from "@/lib/property";
import { FREE_TASTE_PAYWALL } from "@/lib/freeAiTaste";
import { getUser } from "@/lib/auth";
import { trialDecision, TRIAL_DECISION_TTL_MS } from "@/lib/risk/decision";
import {
  manageBillingAction,
  upgradeToYearlyAction,
  downgradeToMonthlyAction,
  keepYearlyAction,
  cancelMembershipAction,
  resumeMembershipAction,
} from "./actions";
import PlanToggle from "./PlanToggle";
import ExtraHomes from "./ExtraHomes";
import PlusWelcome from "./PlusWelcome";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import SubmitButton from "@/components/SubmitButton";
import {
  COLD_START_FREE_POSTING,
  COLD_START_FREE_ALERTS,
  FREE_ASK_PER_DAY,
  PLUS_ASK_PER_DAY,
  PLUS_INCLUDED_HOMES,
  PLUS_PLAN,
  TRIAL_ASK_PER_DAY,
  formatUsd,
  yearlySavings,
} from "@/lib/constants";

const COMPARISON: Array<{ label: string; free: string; plus: string }> = [
  // Plus-exclusive rows lead: they're the reason to upgrade.
  { label: "Maintenance plan", free: "First build free", plus: "Auto-built for your home" },
  { label: "Cost forecast & repair fund", free: "10-year total + set-aside", plus: "Full per-system breakdown" },
  { label: "Quote analyzer", free: "-", plus: "Included" },
  { label: "Home report for resale & insurance", free: "-", plus: "Included" },
  // Photo diagnosis is the Plus-only half of Ask Hearth; the question count is
  // the other half. Every number is read from src/lib/constants.ts, which
  // src/lib/constants.test.ts pins to what src/lib/aiUsage.ts actually
  // enforces, so this row cannot quote an allowance the server does not give.
  // The trial is called out in the Plus column because the 3 free days run on
  // their own, smaller ceiling and a buyer arriving from the weekly card would
  // otherwise read 15 and get 8 on day one.
  {
    label: "Ask Hearth",
    free: `${FREE_ASK_PER_DAY} a day, text only`,
    plus: `${PLUS_ASK_PER_DAY} a day, with photos (${TRIAL_ASK_PER_DAY} during the trial)`,
  },
  // The first estimate for a home is free and stays free (see the note at the
  // top of src/app/(app)/value/actions.ts). "Refresh monthly" is the honest
  // word for what Plus buys: the lookup behind it is cached 30 days, so a
  // monthly pull is as often as the number can actually move.
  {
    label: "Home value",
    free: "First estimate",
    plus: "Refresh monthly, with trend and equity",
  },
  // The two AI reads that used to be free and unlimited. Both numbers must
  // match FREE_DOC_READS / FREE_INSPECTION_READS in src/lib/freeAiTaste.ts,
  // which is what /api/extract-document and /api/ingest-inspection enforce.
  // Storing documents is still free and uncapped: only the AI read is metered,
  // which is why the vault row below still says "Included" for both columns.
  {
    label: "Document vault AI read",
    free: "2 free, then Plus",
    plus: "Unlimited",
  },
  { label: "Inspection report import", free: "1 free", plus: "Unlimited" },
  // When the posting cap is on, unlimited postings are a real Plus perk, so
  // the row sits up here with the other upgrades.
  ...(COLD_START_FREE_POSTING
    ? []
    : [{ label: "Open job postings", free: "3 at a time", plus: "Unlimited" }]),
  // COLD START: while COLD_START_FREE_ALERTS is on, every pro hears about
  // every matching job instantly, so "priority matching" isn't a real perk
  // yet. The row returns when the flag flips.
  ...(COLD_START_FREE_ALERTS
    ? []
    : [{ label: "Matching to pros", free: "Standard", plus: "Priority" }]),
  { label: "Home tracking & document vault", free: "Included", plus: "Included" },
  // Same rule as the Ask row: the number comes from the constant the claim cap
  // in claimPropertyAction actually enforces, never a typed digit.
  {
    label: "Homes you can track",
    free: "1 home",
    plus: `Up to ${PLUS_INCLUDED_HOMES} homes`,
  },
  { label: "Proactive alerts", free: "In-app", plus: "All alerts, every channel" },
  // COLD START: while COLD_START_FREE_POSTING is on, posting is uncapped for
  // everyone, so the row says so honestly and sits last, since it isn't a
  // selling point right now. The gated version moves back up when the flag
  // flips.
  ...(COLD_START_FREE_POSTING
    ? [
        {
          label: "Open job postings",
          free: "Unlimited during launch",
          plus: "Unlimited",
        },
      ]
    : []),
];

export default async function PlusPage(
  props: {
    searchParams: Promise<{ reason?: string; welcome?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  // ownsPlus, not hasPlus: this page manages the viewer's OWN billing. A
  // household member covered by the owner's Plus must still see the buy flow
  // here (their benefits come from the owner's plan, not a row of their own).
  const [plus, sub] = await Promise.all([ownsPlus(), getSubscription()]);

  // One-time celebration right after checkout. Shown off the ?welcome=1 flag so
  // it appears even if the Stripe webhook hasn't synced the subscription yet.
  // When the row HAS landed, the acknowledgment on the last step can state the
  // real plan; when it hasn't, PlusWelcome falls back to the cancellation
  // terms plus a pointer to the emailed acknowledgment. "trialing" is what the
  // free 3-day trial looks like in Stripe, so it is the step-up signal here.
  if (searchParams.welcome === "1") {
    return (
      // Same max-w-md column as the upsell branch below. /plus renders four
      // different things depending on subscription state, and the URL used to
      // change width as you moved between them; pinning every branch to one
      // measure keeps the page from visibly reflowing after checkout.
      <div className="mx-auto max-w-md">
        <PlusWelcome
          plan={
            sub?.status === "canceled"
              ? undefined
              : sub?.plan === "yearly"
              ? "yearly"
              : sub?.plan === "monthly"
              ? "monthly"
              : sub?.plan === "weekly"
              ? "weekly"
              : undefined
          }
          introEligible={sub?.status === "trialing"}
        />
      </div>
    );
  }

  if (plus) {
    // Pending billing changes (downgrade schedule, cancellation), read live
    // from Stripe in one call. Alongside it, the data the "More homes" add-on
    // section needs: how many homes the member owns and how many extra slots
    // they've already bought.
    const [{ scheduledDowngrade, cancelsAt }, properties, extraSlots] =
      await Promise.all([
        getBillingOutlook(sub),
        getProperties(),
        getExtraHomeSlots(),
      ]);
    const homesUsed = properties.filter((p) => !p.isShared).length;
    // The add-on bills on the same cadence as the base plan, so only a
    // monthly/yearly member can buy it. A weekly member must switch cadence
    // first.
    const isWeekly = sub?.plan === "weekly";
    const addonInterval: "monthly" | "yearly" | null =
      sub?.plan === "yearly" ? "yearly" : sub?.plan === "monthly" ? "monthly" : null;
    const renewsOn = sub?.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString()
      : "your renewal date";
    const included = [
      "Unlimited job postings, matched first",
      "Cost forecast and repair fund",
      "Quote analyzer",
      "Home report for resale and insurance",
      "Up to 5 homes",
      "A maintenance plan auto-built for your home",
      "Every proactive alert",
    ];
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Hearth Plus</h1>
        </div>
        <div className="card-hero space-y-4 text-center">
          <p className="text-lg font-medium text-bark-700 dark:text-stone-300">
            You&apos;re on Hearth Plus
          </p>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {sub?.plan === "yearly"
              ? "Yearly"
              : sub?.plan === "weekly"
              ? "Weekly"
              : "Monthly"}{" "}
            plan
            {sub?.current_period_end
              ? ` · renews ${new Date(sub.current_period_end).toLocaleDateString()}`
              : ""}
          </p>
          <form action={manageBillingAction}>
            <SubmitButton className="btn-secondary" pendingLabel="Opening…">
              Manage billing
            </SubmitButton>
          </form>
          {sub?.stripe_subscription_id && cancelsAt && (
            <div className="space-y-2 border-t border-stone-100 pt-4 dark:border-white/10">
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Your membership ends on {cancelsAt.toLocaleDateString()}. You
                keep every Plus benefit until then.
              </p>
              <form action={resumeMembershipAction}>
                <SubmitButton className="btn-secondary" pendingLabel="Saving…">
                  Keep my membership
                </SubmitButton>
              </form>
            </div>
          )}
          {sub?.stripe_subscription_id && !cancelsAt && (
            <div className="space-y-2 border-t border-stone-100 pt-4 dark:border-white/10">
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Change plan
              </p>
              {isWeekly && (
                <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-left text-xs text-stone-600 dark:border-white/10 dark:bg-stone-900 dark:text-stone-300">
                  You&apos;re on the weekly plan. Extra homes come with the
                  monthly and yearly plans, so switch below if you want to add
                  one. Monthly works out cheaper than four weeks, and yearly
                  cheaper still.
                </p>
              )}
              {sub.plan !== "yearly" && (
                <>
                  <form action={upgradeToYearlyAction}>
                    <ConfirmSubmit
                      label={`Switch to yearly, ${formatUsd(PLUS_PLAN.yearly)}/yr (save ${formatUsd(yearlySavings(PLUS_PLAN))} vs monthly)`}
                      note="You'll be charged today, with your unused time credited toward it. Switch to yearly?"
                      yesLabel="Yes, switch to yearly"
                    />
                  </form>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Starts today. Your unused time is credited toward the yearly
                    charge.
                  </p>
                </>
              )}
              {(sub.plan === "yearly" || isWeekly) && !scheduledDowngrade && (
                <>
                  <form action={downgradeToMonthlyAction}>
                    <ConfirmSubmit
                      label="Switch to monthly at renewal"
                      note={`Nothing changes today. You keep what you have until ${renewsOn}, then it becomes ${formatUsd(PLUS_PLAN.monthly)}/mo. Switch?`}
                      yesLabel="Yes, switch at renewal"
                    />
                  </form>
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    You keep every Plus benefit through {renewsOn}. Monthly
                    billing starts after that, so you lose nothing you paid for.
                  </p>
                </>
              )}
              {(sub.plan === "yearly" || isWeekly) && scheduledDowngrade && (
                <>
                  <p className="text-sm text-stone-600 dark:text-stone-300">
                    Switching to monthly on{" "}
                    {scheduledDowngrade.switchesAt.toLocaleDateString()}
                  </p>
                  <form action={keepYearlyAction}>
                    <SubmitButton className="btn-secondary" pendingLabel="Saving…">
                      {isWeekly ? "Keep my current plan" : "Keep yearly"}
                    </SubmitButton>
                  </form>
                </>
              )}
              <form action={cancelMembershipAction} className="pt-1">
                <ConfirmSubmit
                  subtle
                  label="Cancel membership"
                  note={`You'd keep every Plus benefit through ${renewsOn}, and it just won't renew after that. Cancel?`}
                  yesLabel="Yes, cancel my membership"
                />
              </form>
            </div>
          )}
        </div>
        {/* Pay-per-extra-home add-on, monthly/yearly members only. A weekly
            member can't buy it (the add-on Prices are monthly/yearly, and
            Stripe needs one interval per subscription) - the note in the
            Change plan block above tells them to switch cadence first. */}
        {addonInterval && (
          <ExtraHomes
            interval={addonInterval}
            currentSlots={extraSlots}
            homesUsed={homesUsed}
          />
        )}
        <div className="card">
          <p className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Everything you have
          </p>
          <ul className="space-y-2">
            {included.map((f) => (
              <li
                key={f}
                className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"
              >
                <span className="mt-0.5 font-bold text-green-600">✓</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  // A subscription that Stripe still considers live but that ownsPlus() reads
  // as not-entitled (past_due, unpaid, incomplete: the card failed and Stripe
  // is retrying) used to fall straight through to the marketing pitch below,
  // leaving someone whose card is ACTIVELY being retried with no way to stop
  // the charges except email. That is exactly the "simple mechanism to stop
  // recurring charges" ROSCA requires (15 U.S.C. 8403(3)), so the cancel and
  // billing controls stay reachable whenever a cancellable subscription
  // exists, entitled or not. Canceled rows fall through: there is nothing
  // left to stop.
  if (sub?.stripe_subscription_id && sub.status !== "canceled") {
    return (
      // max-w-md, matching the welcome and upsell branches: one measure for
      // every state this URL can render.
      <div className="mx-auto max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            Hearth Plus
          </h1>
        </div>
        <div className="card space-y-4 text-center">
          <p className="text-sm text-stone-600 dark:text-stone-300">
            We couldn&apos;t take your last Hearth Plus payment, so your Plus
            features are paused while your bank and Stripe sort it out. Update
            your payment method to switch them back on, or cancel so nothing
            further is charged.
          </p>
          <form action={manageBillingAction}>
            <SubmitButton className="btn-primary" pendingLabel="Opening…">
              Update payment method
            </SubmitButton>
          </form>
          <div className="border-t border-stone-100 pt-4 dark:border-white/10">
            <form action={cancelMembershipAction}>
              <ConfirmSubmit
                subtle
                label="Cancel membership"
                note="Your membership stops renewing and nothing further is charged. Cancel?"
                yesLabel="Yes, cancel my membership"
              />
            </form>
          </div>
        </div>
        <p className="text-center text-xs text-stone-500 dark:text-stone-400">
          Questions?{" "}
          <Link href="/account/help" className="hover:underline">
            Visit help
          </Link>
          .
        </p>
      </div>
    );
  }

  // The 3-day trial is granted only when there's no existing homeowner
  // subscription row (the same signal startPlusCheckoutAction checks), so a
  // returning subscriber never sees trial copy they wouldn't get.
  //
  // The trial-abuse decision is ANDed in for the same reason (src/lib/risk):
  // startPlusCheckoutAction drops the trial for a medium-risk account, and the
  // auto-renewal disclosure this flag feeds is the sentence the buyer consents
  // to before any billing information is collected. If the page promised "free
  // for 3 days" and Stripe charged on day one, the disclosure would be wrong in
  // the one direction ROSCA and California's Automatic Renewal Law actually
  // care about. Nothing else on the page changes: the plans, the prices and the
  // buttons are identical, the copy simply states the immediate charge.
  // getUser (the cached, cookie-read one), not getVerifiedUser: this decides
  // COPY, not money. startPlusCheckoutAction re-verifies against Supabase's auth
  // server and re-runs the same decision before anything is charged, so a
  // cookie-edited id here could only ever mislead the person holding the
  // cookie about their own screen.
  const viewer = await getUser();
  // Only worth deciding when a trial is even possible: an existing subscriber
  // (sub is truthy) can never see trial copy, so the ~10 service-role queries
  // trialDecision runs would be spent computing an answer trialEligible below
  // throws away.
  const risk =
    viewer && !sub
      ? await trialDecision(viewer.id, {
          accountCreatedAt: viewer.created_at ?? null,
          // A page render is a GET: compute, do not write. The checkout action
          // re-runs the same decision and records it there.
          persist: false,
          // ...and it may reuse a recent answer rather than re-running the
          // whole fan-out on every refresh of an upsell page. Render path only:
          // startPlusCheckoutAction passes no maxAgeMs, so the decision that
          // actually gates money is always computed fresh. See decision.ts for
          // what is never cached (high, and any refused checkout).
          maxAgeMs: TRIAL_DECISION_TTL_MS,
        })
      : null;
  const trialEligible =
    (await isPlusTrialEligible()) && (risk?.allowTrial ?? true);

  // Free-taste credit for the quote analyzer, read from the SAME column the
  // tool itself claims against (users.free_quote_used_at - see
  // src/app/api/analyze-quote/route.ts). The reason=quote banner below used to
  // assert "you've used your free quote check" unconditionally, which was a
  // lie to anyone who landed here from a tile or a bare link without having
  // spent anything. Only looked up when that banner can actually render, and
  // it fails to the GENERIC pitch on any error or missing row: never tell
  // someone they burned a credit we cannot prove they burned.
  //
  // Reuses `viewer` (the cached getUser() resolved above) instead of a second
  // supabase.auth.getUser(), which was a full network hop to Supabase's auth
  // server just to re-learn an id this render already had. Safe for the same
  // reason the risk decision above uses it: the row is RLS-protected and the
  // select is pinned to that id, so the worst a cookie-edited id can do is
  // mislead the cookie's own holder about their own screen.
  let quoteCreditSpent = false;
  if (searchParams.reason === "quote" && viewer) {
    const supabase = await createClient();
    const { data: creditRow } = await supabase
      .from("users")
      .select("free_quote_used_at")
      .eq("id", viewer.id)
      .maybeSingle();
    quoteCreditSpent = !!creditRow?.free_quote_used_at;
  }

  return (
    // Wider than the other branches of this URL (max-w-md): the pitch is three
    // plan columns side by side, and they need the room from sm up. On a phone
    // the viewport is narrower than either measure, so the columns sit shoulder
    // to shoulder there either way.
    <div className="mx-auto max-w-md space-y-4 sm:max-w-2xl sm:space-y-6">
      {/* COLD START: the posting cap is off while COLD_START_FREE_POSTING is
          on, so this banner must not show even if the URL is hit directly.
          Keep it for when the flag flips back. */}
      {!COLD_START_FREE_POSTING && searchParams.reason === "job_limit" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            You&apos;ve used all 3 of your free job posts. Hearth Plus lets you
            post unlimited jobs and keeps the quotes rolling.
          </p>
        </div>
      )}

      {searchParams.reason === "home_limit" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            You&apos;ve added your free home. Hearth Plus lets you manage up
            to 5 homes in one place.
          </p>
        </div>
      )}

      {searchParams.reason === "plan" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Hearth Plus builds a maintenance plan tuned to your home&apos;s
            systems, a few tasks at a time, so it never piles up.
          </p>
        </div>
      )}

      {searchParams.reason === "forecast" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Hearth Plus forecasts what your home will need over the next 10
            years, and how much to set aside each month. A big repair
            becomes a plan, not a panic.
          </p>
        </div>
      )}

      {searchParams.reason === "quote" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            {quoteCreditSpent
              ? "You've used your free quote check. Plus reads every quote you get, flags padding, and writes the negotiation message, unlimited."
              : "Hearth Plus reads every quote you get, flags anything padded, vague, or duplicated, and writes the message you send back to negotiate."}
          </p>
        </div>
      )}

      {searchParams.reason === "ask" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Ask Hearth photo answers and more questions come with Plus.
          </p>
        </div>
      )}

      {searchParams.reason === "report" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Plus builds your requote packet: your home&apos;s facts, upkeep
            record, and the questions to ask. Hand it to agents and let them
            compete for you.
          </p>
        </div>
      )}

      {searchParams.reason === "tax" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Your assessment looks high. Plus drafts the appeal letter for
            you, ready to file with your county.
          </p>
        </div>
      )}

      {/* Same voice as the rest: name the specific thing gained, no urgency.
          Your first estimate is free and stays free, so this banner never
          claims to give back something that was taken away. */}
      {searchParams.reason === "value" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Your first home value estimate is free. Plus refreshes it monthly
            with new sales near you, and opens the year-by-year trend and how
            your equity has built up.
          </p>
        </div>
      )}

      {searchParams.reason === "insurance" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            Plus builds your requote packet: your home&apos;s facts, upkeep
            record, and the questions to ask, ready to hand to insurance
            agents so they compete for you.
          </p>
        </div>
      )}

      {/* The two AI reads that now carry a free taste. The wording is the SAME
          sentence /api/extract-document and /api/ingest-inspection send, and
          the same one the upload cards show before the tap, so a homeowner who
          lands here has already read it: see FREE_TASTE_PAYWALL in
          src/lib/freeAiTaste.ts. Uploading and storing documents is not gated
          at all - only the AI read is - and the copy says so. */}
      {searchParams.reason === "documents" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            {FREE_TASTE_PAYWALL.document.message} Adding and storing documents
            stays free.
          </p>
        </div>
      )}

      {searchParams.reason === "inspection" && (
        <div className="card border-bark-100 bg-bark-50 text-center dark:border-bark-700/40 dark:bg-bark-700/30">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            {FREE_TASTE_PAYWALL.inspection.message}
          </p>
        </div>
      )}

      <div className="text-center">
        {/* Money protection, not job-posting speed: the paid tier's real value
            is knowing what's coming (forecast, quote check, plan) before it
            hits the wallet. The reason banners above add the specific pitch. */}
        <h1 className="text-xl font-semibold text-stone-900 sm:text-3xl dark:text-stone-100">
          Know what&apos;s coming before it costs you
        </h1>
        {/* The trial line that used to sit here is gone: the trial button at
            the top of PlanToggle now states the same three facts (free days,
            price after, cancel before it ends) in the one place a reader is
            about to act on them. Repeating billing mechanics above it was the
            clutter the page was carrying. */}
        {/* Desktop only: on a phone this paragraph is the thing standing
            between the reader and the trial button, and the cards say the
            same thing in fewer words. */}
        <p className="mt-2 hidden text-sm text-stone-500 sm:block dark:text-stone-400">
          {COLD_START_FREE_POSTING
            ? // COLD START: posting is uncapped for everyone right now, so the
              // pitch leans on the perks that stay exclusive.
              "Line up local pros, on your terms. Get matched first and keep every proactive alert working for you."
            : "Line up local pros, on your terms. Post more jobs at once, get matched first, and keep every proactive alert working for you."}
        </p>
      </div>

      <PlanToggle trialEligible={trialEligible} />

      {/* The full comparison stays available but folded, closed by default,
          under the cards. Each card already carries four lines; this is the
          row-by-row version for anyone who wants to check the free tier's
          limits, and it costs no height until it's opened. */}
      <details className="group">
        <summary className="w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden text-sm font-semibold text-stone-900 dark:text-stone-100">
          <span className="mr-1 inline-block transition-transform group-open:rotate-90">
            ▸
          </span>
          See everything included
        </summary>
        <div className="card mt-3 overflow-hidden p-0">
          {/* Tighter cells and smaller text below sm so all three columns fit
              a 360px viewport without horizontal scrolling. */}
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-stone-700 dark:text-stone-400">
                <th className="px-2 py-3 font-medium sm:px-4"> </th>
                <th className="px-2 py-3 font-medium sm:px-4">Free</th>
                <th className="px-2 py-3 font-medium text-bark-700 sm:px-4 dark:text-stone-300">
                  Hearth Plus
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.label} className="border-b border-stone-100 last:border-0 dark:border-white/10">
                  <td className="px-2 py-3 text-stone-700 sm:px-4 dark:text-stone-300">{row.label}</td>
                  <td className="px-2 py-3 text-stone-500 sm:px-4 dark:text-stone-400">{row.free}</td>
                  <td className="px-2 py-3 font-medium text-bark-700 sm:px-4 dark:text-stone-300">
                    {row.plus}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="text-center text-xs text-stone-500 dark:text-stone-400">
        Questions?{" "}
        <Link href="/account/help" className="hover:underline">
          Visit help
        </Link>
        .
      </p>
    </div>
  );
}
