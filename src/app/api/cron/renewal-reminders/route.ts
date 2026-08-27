import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { stripe } from "@/lib/stripe";
import { billingTerms, type PaidPlan } from "@/lib/billingTerms";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) that warns paying members BEFORE a
// charge they might not be expecting. Four cases:
//
//   1. Trial ending. A brand-new Hearth Plus subscriber who starts on the
//      WEEKLY plan (the only Plus cadence carrying free days; monthly and
//      yearly bill at signup) gets a 3-day Stripe free trial, and the notice
//      fires about a day before that trial ends and the first real charge
//      lands. Both Pro cadences trial the same way. California's Automatic Renewal Law
//      3-to-21-day
//      window for free periods only kicks in past 31 days, so for this
//      3-day trial the 1-day lead is not a statutory requirement, it is a
//      best-practice heads-up and a chargeback defense. A legacy month-long
//      trial is long enough to fall inside that statutory window, so it
//      keeps the same 5-day lead the step-up case below uses.
//   2. Step-up. The current period is running on an intro month (Hearth
//      Pro), and the next charge is at the higher standard price. This is
//      the case regulators care most about, because the amount changes
//      without the member doing anything.
//   3. Yearly renewal. A 12-month term is about to auto-renew for another
//      12 months at the same price.
//   4. Annual continuous-service notice. Once every calendar year, every
//      ACTIVE (past-trial, not set to cancel) Plus or Pro subscriber gets a
//      reminder that their membership renews automatically, on ANY cadence
//      (weekly, monthly, or yearly). This case is not windowed against
//      current_period_end the way 1-3 are: California's Automatic Renewal
//      Law, as amended by AB 2863 (effective July 1, 2025), extended the
//      annual-reminder requirement in Bus. & Prof. Code 17602(h) to cover
//      ongoing weekly and monthly subscriptions, not just terms of a year or
//      longer, so a monthly member now needs the same once-a-year "this
//      renews automatically" notice a yearly member already gets near their
//      term date under case 3. See the ANNUAL NOTICE section below for how
//      this case is queried and de-duplicated separately from cases 1-3.
//
// The windows for cases 1-3 come from California's Automatic Renewal Law
// (Bus. & Prof. Code 17602(a)(5)-(6)): 3 to 21 days before a promotional or
// free period ends, and 15 to 45 days before a term of a year or longer
// renews. Reminders fire at the near edge of each window (a few days out,
// not three weeks out) so the notice arrives when it is still actionable and
// does not read as noise. Case 4 is not a pre-charge warning tied to a
// renewal date, it is a once-a-year notice, so it has no "days out" window
// to sit inside.
//
// An ordinary monthly renewal at an unchanged price still gets no PER-PERIOD
// reminder: nothing requires one, the amount is not changing, and a monthly
// "you're about to be charged again" is the kind of message people mute,
// which would bury the notices above that actually matter. But every such
// subscriber DOES get case 4's once-a-year notice, which is what 17602(h)
// now requires for continuous-service agreements regardless of cadence.
//
// Noise control: at most one reminder per subscription per period for cases
// 1-3. The dup guard is keyed to the PERIOD ITSELF - the period end date
// rides in the notification url, except for the trial_end kind, where the
// key is the trial's own end date (the same date as the period end while
// trialing, but named explicitly so the anchor is documented rather than
// incidental) - so daily re-runs across the whole window are no-ops and the
// next period, which has a new end date, re-arms the guard on its own. Case
// 4 uses its own kind ("annual_notice") and its own dup guard keyed to the
// CALENDAR YEAR rather than the period, since it has to fire once a year on
// any cadence, including cadences (weekly, monthly) that roll over many
// times before a year is up. Same once-per-key-forever pattern as the
// insurance-renewal cron.
//
// Notification preferences are deliberately NOT consulted. These are billing
// notices required before money moves, not marketing, and a muted "reminders"
// toggle must not suppress one.

// Step-up reminders: fire this many days before the discounted period ends.
// Inside the 3-21 day window, near the actionable end.
const STEP_UP_LEAD_DAYS = 5;
// Yearly renewal reminders: fire this many days before the term renews.
// Inside the 15-45 day window.
const RENEWAL_LEAD_DAYS = 20;
// Trial-ending reminders: fire this many days before a SHORT trial ends,
// about 24h out. A 3-day trial does not have room for a 5-day lead.
const TRIAL_LEAD_DAYS = 1;
// A trial this short (days) gets the 24h lead above; anything longer (a
// legacy month-long free trial) keeps the step-up case's 5-day lead so the
// notice stays inside the ARL's 3-21 day window for free periods over 31
// days.
const SHORT_TRIAL_MAX_DAYS = 7;

// How wide a slice of dates each run considers. A run that fails or is
// skipped would otherwise leave a permanent hole: catching a few days on
// either side means the next successful run still covers it, and the dup
// guard keeps the overlap from double-sending.
const WINDOW_SLACK_DAYS = 3;

const MAX_SUBSCRIPTIONS = 300; // cap the work (and the Stripe calls) per run
// The annual-notice pass below is a separate query with its own budget
// rather than sharing MAX_SUBSCRIPTIONS, so a run where both passes fill up
// can spend up to MAX_SUBSCRIPTIONS + MAX_ANNUAL_SUBSCRIPTIONS Stripe calls.
const MAX_ANNUAL_SUBSCRIPTIONS = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

const REMINDER_KIND = "renewal_reminder";
// Separate kind from REMINDER_KIND: case 4 (see header comment) satisfies a
// different legal requirement on a different cadence (once a calendar year,
// not once a billing period), so it gets its own kind rather than sharing
// REMINDER_KIND, keeping the two dup guards from ever colliding on the same
// url.
const ANNUAL_NOTICE_KIND = "annual_notice";

// PostgREST silently truncates every response at its max-rows cap. The
// per-user lookups here fetch at most one row per id, so 200 stays well under
// it; the dup guard is a per-candidate exact query and never relies on a bulk
// read.
const QUERY_CHUNK = 200;
// Stripe is consulted once per candidate, so keep the fan-out small.
const SEND_CHUNK = 10;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // the CRON_SECRET env var is set. Also accept an explicit x-cron-secret
  // header for manual runs / other schedulers.
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const provided = bearer ?? req.headers.get("x-cron-secret");
  if (!provided) return false;
  // Constant-time compare (mirrors src/lib/checkr.ts / the twilio inbound
  // webhook): only call timingSafeEqual once both buffers are a confirmed
  // equal length, since it throws on a length mismatch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// "March 5, 2027" for the reminder body.
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Normalize a stored plan string to the union billingTerms understands.
// Anything unrecognized returns null and the row is skipped rather than
// guessed at: a reminder quoting the wrong price is worse than none.
function toPaidPlan(plan: string | null | undefined): PaidPlan | null {
  if (plan === "weekly" || plan === "monthly" || plan === "yearly") return plan;
  if (plan === "pro_monthly" || plan === "pro_yearly") return plan;
  return null;
}

type SubRow = {
  user_id: string;
  plan: string | null;
  status: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
};

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = Date.now();

  // One query covering the union of both windows, narrowed per-row below.
  // The far edge is the yearly window plus slack; the near edge is today,
  // since a period ending in the next few days still needs its step-up
  // notice.
  const horizon = new Date(
    now + (RENEWAL_LEAD_DAYS + WINDOW_SLACK_DAYS) * DAY_MS
  ).toISOString();
  const floor = new Date(now).toISOString();

  const { data: rawSubs, error: subsError } = await (
    supabase.from("subscriptions") as any
  )
    .select("user_id, plan, status, stripe_subscription_id, current_period_end")
    .in("status", ["active", "trialing"])
    // Weekly is sold again and is now the cadence that carries the free days,
    // so this filter matters more than ever. An ACTIVE weekly sub gets no
    // notice here (a renewal every 7 days is not news, and case 4 below gives
    // it the once-a-year notice the law asks for), yet its current_period_end
    // is always inside this query's short horizon, so it would sit in the
    // window forever, crowding out monthly/yearly candidates against
    // MAX_SUBSCRIPTIONS and burning a Stripe retrieve every run for nothing.
    // Only a TRIALING weekly sub can be due here, so only that one is fetched -
    // and that is exactly the row whose trial-end notice must go out.
    .or("plan.neq.weekly,status.eq.trialing")
    .not("stripe_subscription_id", "is", null)
    .not("current_period_end", "is", null)
    .gte("current_period_end", floor)
    .lte("current_period_end", horizon)
    // Soonest first, so the recipient set stays stable when a run hits the cap.
    .order("current_period_end", { ascending: true })
    .limit(MAX_SUBSCRIPTIONS);

  if (subsError) {
    console.error(
      "renewal-reminders cron: subscriptions query failed:",
      subsError.message
    );
    return NextResponse.json(
      { checked: 0, notified: 0, error: subsError.message },
      { status: 200 }
    );
  }

  const subs = ((rawSubs ?? []) as SubRow[]).filter(
    (s) => Boolean(s.user_id) && Boolean(s.stripe_subscription_id)
  );

  // ANNUAL NOTICE (case 4 in the header comment above): a second, separate
  // query for the AB 2863 / 17602(h) once-a-year notice. It cannot share the
  // query above, which is windowed tightly around current_period_end and
  // deliberately excludes active weekly subs (see the .or() filter's comment
  // a few lines up) - reusing that query here would reopen the exact
  // weekly-starvation problem that filter exists to close, since a weekly
  // sub's current_period_end is always inside a few-day window but this
  // notice is due only once a year.
  //
  // Instead this pass works off a per-year backlog: the year is baked into
  // the notification url (see ANNUAL_NOTICE_KIND below), so once a
  // subscriber gets this year's notice they drop out of the candidate set
  // and stay out until January 1 re-arms it. That means MAX_ANNUAL_SUBSCRIPTIONS
  // only ever gets spent on subscribers still owed a notice this year, and a
  // subscriber base under that cap clears out early in the year and goes
  // quiet - no day-of-year math needed to spread the work out.
  const year = new Date(now).getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1)).toISOString();

  // Everyone already covered for `year`, so the candidate query below can
  // exclude them up front instead of spending a Stripe call to find out. The
  // per-row dup guard further down still runs as the real safety net, so an
  // incomplete list here (past this generous limit) risks a wasted Stripe
  // call, never a duplicate notification.
  const { data: alreadyNotified } = await supabase
    .from("notifications")
    .select("user_id")
    .eq("kind", ANNUAL_NOTICE_KIND)
    .gte("created_at", yearStart)
    .limit(5000);
  const excludedIds = Array.from(
    new Set((alreadyNotified ?? []).map((n) => n.user_id as string))
  );

  // Active (not trialing), not already covered for `year`, has a live
  // Stripe subscription to check. Trialing is excluded here at the query
  // level, not just left to the Stripe check below: a member still inside
  // their free trial has not yet agreed to a recurring charge worth this
  // notice, and case 1 (trial_end) already covers that member. Unlike the
  // query above, EVERY cadence is wanted here, including weekly, so there is
  // no plan filter.
  let annualQuery = (supabase.from("subscriptions") as any)
    .select("user_id, plan, status, stripe_subscription_id, current_period_end")
    .eq("status", "active")
    .not("stripe_subscription_id", "is", null)
    // No natural "soonest first" for this pass (every candidate is equally
    // due until the year is covered), so user_id just gives a stable order.
    .order("user_id", { ascending: true })
    .limit(MAX_ANNUAL_SUBSCRIPTIONS);
  for (const ids of chunk(excludedIds, QUERY_CHUNK)) {
    annualQuery = annualQuery.not("user_id", "in", `(${ids.join(",")})`);
  }
  const { data: rawAnnualSubs, error: annualError } = await annualQuery;
  if (annualError) {
    console.error(
      "renewal-reminders cron: annual-notice subscriptions query failed:",
      annualError.message
    );
  }
  const annualSubs = ((rawAnnualSubs ?? []) as SubRow[]).filter(
    (s) => Boolean(s.user_id) && Boolean(s.stripe_subscription_id)
  );

  if (subs.length === 0 && annualSubs.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  // Contact details for the email channel.
  const userIds = Array.from(
    new Set([...subs.map((s) => s.user_id), ...annualSubs.map((s) => s.user_id)])
  );
  const userById = new Map<string, { id: string; email: string | null }>();
  for (const ids of chunk(userIds, QUERY_CHUNK)) {
    const { data: users } = await supabase
      .from("users")
      .select("id, email")
      .in("id", ids)
      .order("id", { ascending: true });
    for (const u of users ?? []) userById.set(u.id, u);
  }

  let checked = 0;
  let notified = 0;

  for (const batch of chunk(subs, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (sub) => {
        checked += 1;
        try {
          const plan = toPaidPlan(sub.plan);
          if (!plan || !sub.current_period_end) return;

          const periodEnd = new Date(sub.current_period_end);
          const daysOut = Math.round((periodEnd.getTime() - now) / DAY_MS);

          // Stripe is the authority on what happens next. A subscription
          // already set to cancel gets nothing: there is no upcoming charge
          // to warn about, and a "you'll be charged" notice would be false.
          // The discount / trial state also lives here, not on our row.
          let stripeSub: any;
          try {
            stripeSub = await stripe.subscriptions.retrieve(
              sub.stripe_subscription_id as string
            );
          } catch {
            // Stripe unreachable for this one: skip it. The window is days
            // wide and the next run retries.
            return;
          }
          if (stripeSub.cancel_at_period_end || stripeSub.cancel_at) return;

          // Is the CURRENT period the cheap one? A live trial (Hearth Plus's
          // free month) or a discount on the subscription (Hearth Pro's intro
          // month) both mean the next charge is higher than the last.
          const trialing =
            stripeSub.status === "trialing" ||
            (typeof stripeSub.trial_end === "number" &&
              stripeSub.trial_end * 1000 > now);

          // How long the trial runs, in days, so a short 3-day Plus trial and
          // a legacy month-long free trial can use different lead windows
          // below. Stripe's trial_start/trial_end are unix SECONDS; older
          // subscriptions can be missing trial_start, so start_date (also
          // seconds) is the fallback for when the trial began. Unknown length
          // is treated as short below: a lead time that is too long is a
          // wasted notice, one that is too short is a surprise charge.
          const trialStartSec =
            typeof stripeSub.trial_start === "number"
              ? stripeSub.trial_start
              : stripeSub.start_date;
          const trialLengthDays: number | null =
            typeof stripeSub.trial_end === "number" &&
            typeof trialStartSec === "number"
              ? Math.round((stripeSub.trial_end - trialStartSec) / 86400)
              : null;

          // When actually trialing, how many days until that trial ends
          // (and the first real charge fires). Falls back to periodEnd on
          // the rare row where trial_end itself is missing but the status
          // still says "trialing".
          let trialEndMs: number | null = null;
          let trialDaysOut: number | null = null;
          if (trialing) {
            trialEndMs =
              typeof stripeSub.trial_end === "number"
                ? stripeSub.trial_end * 1000
                : periodEnd.getTime();
            trialDaysOut = Math.round((trialEndMs - now) / DAY_MS);
          }

          const discountList = stripeSub.discounts;
          const discounted = Array.isArray(discountList)
            ? discountList.length > 0
            : Boolean(discountList ?? stripeSub.discount);

          // The durable signal, stamped at checkout (see both checkout
          // actions). It exists because Hearth Pro's intro month is a
          // duration:"once" coupon: Stripe consumes it on the first invoice
          // and detaches it, so by the time this cron runs - days before the
          // intro month ends - `discounted` above is already false and the
          // step-up would go unannounced. The flag only describes the FIRST
          // period, so it is paired with a first-period check; afterwards the
          // subscription bills the standard price and nothing steps up.
          const periodStart =
            stripeSub.current_period_start ??
            stripeSub.items?.data?.[0]?.current_period_start ??
            null;
          const firstPeriod =
            typeof stripeSub.start_date === "number" &&
            typeof periodStart === "number" &&
            stripeSub.start_date >= periodStart;
          const flaggedStepUp =
            stripeSub.metadata?.intro_step_up === "true" && firstPeriod;

          const stepUp = trialing || discounted || flaggedStepUp;

          const yearly = plan === "yearly" || plan === "pro_yearly";

          // Pick the notice this subscription is due for, if any. Trial-end
          // wins over everything else: it applies to any subscription Stripe
          // reports as trialing (Plus weekly, both Pro cadences), and a trial
          // about to end is the most time-sensitive of the three notices.
          let due: "trial_end" | "step_up" | "renewal" | null = null;
          if (
            trialing &&
            trialDaysOut !== null &&
            trialDaysOut >= 0 &&
            (trialLengthDays !== null && trialLengthDays > SHORT_TRIAL_MAX_DAYS
              ? trialDaysOut <= STEP_UP_LEAD_DAYS + WINDOW_SLACK_DAYS
              : trialDaysOut <= TRIAL_LEAD_DAYS)
          ) {
            due = "trial_end";
          } else if (
            // Plus stamps intro_step_up="true" on every new subscriber
            // regardless of cadence (see startPlusCheckoutAction), so a
            // trialing sub also carries flaggedStepUp. Without !trialing
            // here, a brand-new weekly/monthly trial would match this
            // branch on day one and send a premature "intro price ends"
            // notice - a trialing sub belongs to the trial_end branch above
            // only.
            !trialing &&
            (discounted || flaggedStepUp) &&
            !yearly &&
            daysOut <= STEP_UP_LEAD_DAYS + WINDOW_SLACK_DAYS &&
            daysOut >= 0
          ) {
            due = "step_up";
          } else if (
            yearly &&
            !trialing &&
            daysOut <= RENEWAL_LEAD_DAYS + WINDOW_SLACK_DAYS &&
            daysOut >= RENEWAL_LEAD_DAYS - WINDOW_SLACK_DAYS
          ) {
            due = "renewal";
          }
          if (!due) return;

          // A renewal notice must always quote the standard recurring terms,
          // even in the unlikely event a yearly sub carries a stray coupon
          // that makes stepUp true: "membership renews" copy paired with
          // intro/trial pricing would contradict its own title.
          const terms = billingTerms(plan, due !== "renewal" && stepUp);

          // Dup guard keyed to the period: same url means this period was
          // already covered, so daily re-runs across the window are no-ops
          // and next period's new end date re-arms it. The pages ignore
          // unknown query params, so the link still lands correctly. A
          // trial_end notice keys off the trial's own end date rather than
          // current_period_end, since for a trialing sub those two happen to
          // be the same date, but keying off the trial end directly is what
          // actually re-arms the guard once the trial rolls into a normal
          // billing period.
          const trialEndDate = trialEndMs !== null ? new Date(trialEndMs) : periodEnd;
          const renewalParam =
            due === "trial_end"
              ? trialEndDate.toISOString().slice(0, 10)
              : sub.current_period_end.slice(0, 10);
          const url = `${terms.cancelPath}?renewal=${renewalParam}`;
          const { data: existing } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", sub.user_id)
            .eq("kind", REMINDER_KIND)
            .eq("url", url)
            .limit(1)
            .maybeSingle();
          if (existing) return;

          const title =
            due === "trial_end"
              ? `Your ${terms.product} free trial ends on ${fmtDate(trialEndDate)}`
              : due === "step_up"
                ? `Your ${terms.product} intro price ends on ${fmtDate(periodEnd)}`
                : `Your ${terms.product} membership renews on ${fmtDate(periodEnd)}`;

          // The body carries the two things the notice exists to convey: what
          // the next charge is, and how to stop it. `terms.recurring` is the
          // same sentence shown before purchase, so the warning and the
          // original promise are word-for-word consistent.
          const body = `${terms.recurring} ${terms.cancel}`;

          const sent = await sendNotification(supabase, {
            userId: sub.user_id,
            kind: REMINDER_KIND,
            title,
            body,
            url,
            email: userById.get(sub.user_id)?.email ?? null,
            // No SMS: a billing notice is something to keep and re-read, and
            // charging someone's phone plan to warn them about a charge is a
            // poor trade.
            phone: null,
          });
          if (sent) notified += 1;
        } catch {
          // One bad row must not stop the rest of the batch.
        }
      })
    );
  }

  // ANNUAL NOTICE pass (case 4): same chunking, same Stripe cancel-at-period-end
  // check, and the same sendNotification path as the loop above, but its own
  // due-test and its own dup guard, since this notice does not care where the
  // subscriber is in their billing period, only whether they have had one
  // this calendar year.
  for (const batch of chunk(annualSubs, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (sub) => {
        checked += 1;
        try {
          const plan = toPaidPlan(sub.plan);
          if (!plan) return;

          // Stripe is the authority on whether there is still an upcoming
          // charge to remind about, same as the main loop above: a
          // subscription already set to cancel gets nothing, and there is no
          // "you'll be charged" claim left to make.
          let stripeSub: any;
          try {
            stripeSub = await stripe.subscriptions.retrieve(
              sub.stripe_subscription_id as string
            );
          } catch {
            // Stripe unreachable for this one: skip it. The per-year backlog
            // keeps this candidate in the pool until a later run succeeds.
            return;
          }
          if (stripeSub.cancel_at_period_end || stripeSub.cancel_at) return;
          // Belt and braces on top of the status.eq.active query filter:
          // a trialing member has not agreed to a recurring charge yet, and
          // case 1 (trial_end) is the notice for them, not this one.
          if (stripeSub.status === "trialing") return;

          // Past-trial, ongoing member: the same billingTerms() call every
          // other billing surface uses for a member who is no longer
          // trial-eligible, so the price and cancellation wording match
          // everywhere they're stated.
          const terms = billingTerms(plan, false);

          // Dup guard keyed to the CALENDAR YEAR, not the period: this
          // notice exists to satisfy AB 2863's once-a-year requirement
          // regardless of cadence, so the guard re-arms on January 1 rather
          // than at the next period end, which for a weekly or monthly plan
          // would otherwise fire this notice every few weeks instead of once
          // a year.
          const url = `${terms.cancelPath}?annual=${year}`;
          const { data: existing } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", sub.user_id)
            .eq("kind", ANNUAL_NOTICE_KIND)
            .eq("url", url)
            .limit(1)
            .maybeSingle();
          if (existing) return;

          const title = `Your ${terms.product} membership renews automatically`;

          // `terms.recurring` is the same sentence shown before purchase, so
          // this notice stays word-for-word consistent with the pre-checkout
          // disclosure. It opens with "After that," because it is written to
          // follow a "charged today" line; there is no such preceding line
          // here, so strip that lead-in - the remainder starts with the
          // amount and reads correctly on its own.
          const recurringStandalone = terms.recurring.replace(
            /^After that,\s*/i,
            ""
          );
          const body = `${recurringStandalone} ${terms.cancel}`;

          const sent = await sendNotification(supabase, {
            userId: sub.user_id,
            kind: ANNUAL_NOTICE_KIND,
            title,
            body,
            url,
            email: userById.get(sub.user_id)?.email ?? null,
            // No SMS, same reasoning as the main loop: a billing notice is
            // something to keep and re-read, not a text message.
            phone: null,
          });
          if (sent) notified += 1;
        } catch {
          // One bad row must not stop the rest of the batch.
        }
      })
    );
  }

  return NextResponse.json({ checked, notified });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
