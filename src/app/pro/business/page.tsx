import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { buildProStats } from "@/lib/proStats";
import { computeResponseTimeMinutes } from "@/lib/responseTime";
// The body is one client component. That is a streaming fix, not a behaviour
// change: this page is long, so as server markup its Flight row ran past
// React Flight's 3200-byte defer budget and chopped the "Jobs won" section
// into a row of its own (one deferral, measured live 2026-08-30). See the long
// comment at the top of BusinessView.tsx.
import BusinessView from "./BusinessView";
import {
  labelFor,
  JOB_CATEGORIES,
  GHOST_PROTECTION_DAYS,
} from "@/lib/constants";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Friendly pipeline labels, matching the leads board.
const STATUS_LABEL: Record<string, string> = {
  new: "New lead",
  accepted: "Active",
  closed: "Won",
  lost: "Lost",
};

// Days until ghost protection returns this application's fee (never negative:
// once the window has passed the cron refund is imminent).
function refundDaysLeft(appliedAt: string | null | undefined): number {
  const t = new Date(appliedAt ?? "").getTime();
  if (!Number.isFinite(t)) return GHOST_PROTECTION_DAYS;
  const elapsed = (Date.now() - t) / 86_400_000;
  return Math.max(0, Math.ceil(GHOST_PROTECTION_DAYS - elapsed));
}

// Honest phrasing for the median job-posted-to-application gap. Same minute
// buckets as src/lib/responseTime.ts's formatResponseTime, kept local
// because that stat measures how fast a pro applies after a job posts, not
// how fast they reply to a homeowner message: the old copy on this page
// called it "reply speed", which this stat was never actually measuring.
// Absence (null) is the correct state for a slow or unproven time, so a slow
// pro sees nothing discouraging.
function timeToApplyText(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes < 60) return "You typically apply within an hour of a job posting";
  if (minutes < 240) return "You typically apply within a few hours of a job posting";
  if (minutes < 1440) return "You typically apply the same day a job posts";
  return null;
}

// "My Business": one compact cockpit for the numbers a pro actually runs on -
// win rate, spend, cost per job won - plus the wallet and what's in flight.
export default async function ProBusinessPage() {
  const contractor = await getCurrentContractor();
  // No company yet: company setup is the only way in, whatever the account's
  // preferred-side stamp says (see /pro/page.tsx).
  if (!contractor) redirect("/pro/onboarding");

  // Whether an automatic CSLB check can ever run for this pro. Same test as
  // verifyLicenseNowAction (src/app/pro/actions.ts) and PublicProfileForm, so
  // /pro/business and /pro/profile can never disagree about it.
  const serviceState =
    (((contractor as any).service_state as string | null) ?? null) || null;
  const cslbEligible = serviceState === null || serviceState === "CA";

  const supabase = await createClient();

  const [
    { data: myApps },
    { data: wonData },
    { data: wallet },
    { data: reviewRows },
    isPro,
    proSub,
    medianApplyMinutes,
  ] = await Promise.all([
    (supabase as any).rpc("my_applications"),
    supabase
      .from("contractor_leads")
      // paid is fetched alongside status so the row below can decide
      // whether to offer a win share card using the same win definition
      // as src/app/api/win-card/[leadId]/route.tsx: paid, or accepted or
      // closed in the pipeline. The status filter keeps this list honest:
      // an assigned job that later fell through (lost) is not a win and
      // should never sit under a "Jobs won" heading.
      .select("id, category, status, paid, created_at")
      .eq("contractor_id", contractor.id)
      .in("status", ["accepted", "closed"])
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("wallets")
      .select("id, cash_balance_cents, bonus_balance_cents")
      .eq("contractor_id", contractor.id)
      .maybeSingle(),
    // Recent reviews worth sharing: same >= 4 star floor as the review-card
    // route (src/app/api/review-card/[reviewId]/route.tsx), so nothing shown
    // here ever links to a card that route would 404 on.
    supabase
      .from("reviews")
      .select("id, rating, comment, created_at")
      .eq("contractor_id", contractor.id)
      .gte("rating", 4)
      .order("created_at", { ascending: false })
      .limit(5),
    hasProPlan(),
    // The Pro-side subscription row itself, for the two upgrade nudges below.
    // The free trial is for brand-new members only and the row survives a
    // cancellation, so a pro who churned and came back must never be offered
    // one. Free to ask for: hasProPlan() reads the same request-cached rows.
    getProSubscription(),
    // Time to apply: median minutes from job-posted to this pro's application,
    // over their last up to 20 applications. Needs the admin client because
    // most of a pro's application history is against jobs that stayed open or
    // went to another pro, and "leads contractor select" RLS only covers leads
    // currently assigned to them - a user-scoped client can't read those
    // leads' posted-at timestamps. Only timestamps/ids are read here, nothing
    // homeowner-facing.
    //
    // In this wave rather than after it: contractor.id is all it needs, and
    // it was two more stacked round trips (it does an applications read then a
    // leads read) sitting between this page's data and its first byte. Now it
    // runs alongside the reads above instead of behind them.
    computeResponseTimeMinutes(createAdminClient(), contractor.id),
  ]);

  // Only a pro who has never held a membership will actually get the trial.
  const trialEligible = !isPro && !proSub;

  const apps = (myApps ?? []) as any[];
  const won = (wonData ?? []) as any[];
  const shareableReviews = reviewRows ?? [];

  const timeToApplyStat = timeToApplyText(medianApplyMinutes);
  // A slow median (or one too slow for timeToApplyText to say anything
  // about, per its "show nothing slow" rule) is exactly when the nudge below
  // is worth showing; a fast one gets the stat line instead.
  const showApplySpeedNudge =
    medianApplyMinutes !== null && medianApplyMinutes > 60;
  // Public profile URL, same slug-preferred pattern as win-card and
  // src/app/p/[id]/page.tsx: the real slug (0043) when the pro has one, the
  // bare contractor id otherwise. Never the truncated 8-char id used for the
  // referral code above; this one has to resolve on /p/<...>.
  const proSlug = (contractor as any).slug as string | null | undefined;
  const profileUrl = `${SITE_URL}/p/${proSlug || contractor.id}`;

  const cash = Number((wallet as any)?.cash_balance_cents ?? 0);
  const bonus = Number((wallet as any)?.bonus_balance_cents ?? 0);

  // Total spent = every debit on the wallet (apply fees, lead charges). Same
  // math as the leads board's "Your results" card. Bounded so one wallet with
  // a huge ledger can't make this page fetch unbounded rows; 1000 transactions
  // is far beyond a typical pro's history.
  const { data: txnRows } = (wallet as any)?.id
    ? await (supabase as any)
        .from("wallet_transactions")
        .select("cash_delta_cents, bonus_delta_cents")
        .eq("wallet_id", (wallet as any).id)
        .limit(1000)
    : { data: [] };
  const spentCents = (txnRows ?? []).reduce((sum: number, t: any) => {
    const delta =
      Number(t.cash_delta_cents ?? 0) + Number(t.bonus_delta_cents ?? 0);
    return delta < 0 ? sum + Math.abs(delta) : sum;
  }, 0);

  const appliedCount = apps.length;
  const wonCount = apps.filter((a) => a.status === "chosen").length;
  // Win rate only means something with a few data points behind it.
  const winRate =
    appliedCount >= 3 ? Math.round((wonCount / appliedCount) * 100) : null;
  const costPerWin = wonCount > 0 ? spentCents / wonCount : null;

  // In flight: applications the homeowner hasn't answered yet.
  const pendingApps = apps.filter(
    (a) => a.status === "applied" && !a.refunded_at
  );

  // Pro perk: the deeper Insights block, computed from the rows above (no
  // extra queries). Non-members get a teaser with one real stat instead.
  const stats = isPro ? buildProStats(apps, new Date()) : null;
  const trendMax = stats
    ? Math.max(...stats.trend.map((m) => m.applications), 1)
    : 1;

  // Non-member teaser rows: the pro's REAL trades, ordered by how much they
  // have applied in each. Only the category name and the application count
  // cross the wire - the win rate and average fee render as placeholder
  // glyphs, never the true number hidden under a CSS blur, because a blur is
  // a costume and anyone can read the page source through it.
  const teaserCategories = isPro
    ? []
    : (() => {
        const byCategory = new Map<string, number>();
        for (const a of apps) {
          const key = a?.category;
          if (typeof key !== "string" || !key) continue;
          byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
        }
        return Array.from(byCategory, ([category, applications]) => ({
          category,
          applications,
        }))
          .sort((x, y) => y.applications - x.applications)
          .slice(0, 6);
      })();

  return (
    <BusinessView
      timeToApplyStat={timeToApplyStat}
      showApplySpeedNudge={showApplySpeedNudge}
      isPro={isPro}
      trialEligible={trialEligible}
      winRate={winRate}
      wonCount={wonCount}
      appliedCount={appliedCount}
      spentCents={spentCents}
      costPerWin={costPerWin}
      cashCents={cash}
      bonusCents={bonus}
      account={{
        referralCode:
          ((contractor as any).slug as string | null | undefined) ||
          contractor.id.slice(0, 8),
        license: {
          expires: contractor.license_expires ?? null,
          docPath: contractor.license_doc_path ?? null,
        },
        // The number and its CSLB result (0037/0055/0125), read off the same
        // columns /pro/profile renders from so the two screens can never
        // disagree about whether a license is on file.
        verification: {
          number: contractor.license_number ?? null,
          status: contractor.license_verified_status ?? "unverified",
          verifiedAt: contractor.license_verified_at ?? null,
          statusText: contractor.license_verify_detail?.statusText ?? null,
          identityFailure: Boolean(
            contractor.license_verify_detail?.failure_reason
          ),
          // Mirrors verifyLicenseNowAction and PublicProfileForm exactly: a
          // null/blank service_state ("All states", or a pre-0046 row) can
          // still run an explicit check; an explicit non-CA state cannot,
          // because the CSLB only holds California licenses. The card needs
          // this to tell "nobody has checked it yet" apart from "nothing
          // will ever check it automatically".
          cslbEligible,
        },
        insurance: {
          expires: (contractor as any).insurance_expires ?? null,
          docPath: contractor.insurance_doc_path ?? null,
        },
      }}
      stats={stats}
      trendMax={trendMax}
      teaserCategories={teaserCategories}
      // The ghost-protection countdown reads the clock, so it is resolved
      // here rather than in the client component: a browser one minute past
      // midnight would otherwise render a different number than SSR did.
      pendingApps={pendingApps.map((a) => {
        const daysLeft = refundDaysLeft(a.applied_at);
        return {
          applicationId: a.application_id as string,
          categoryLabel: labelFor(JOB_CATEGORIES, a.category),
          description: a.issue_description ?? null,
          refundLine:
            daysLeft === 0
              ? "Fee comes back as credit today if no response"
              : `Fee comes back as credit in ${daysLeft} day${
                  daysLeft === 1 ? "" : "s"
                } if no response`,
        };
      })}
      // Same rule for the won date: toLocaleDateString reads the runtime's
      // locale and time zone, so it stays on this side.
      wonJobs={won.map((l) => ({
        id: l.id as string,
        categoryLabel: labelFor(JOB_CATEGORIES, l.category),
        metaLine: `${STATUS_LABEL[l.status] ?? l.status} · ${new Date(
          l.created_at
        ).toLocaleDateString()}`,
        shareable: Boolean(
          l.paid || l.status === "accepted" || l.status === "closed"
        ),
      }))}
      businessName={contractor.name}
      shareableReviews={shareableReviews.map((r: any) => ({
        id: r.id as string,
        rating: r.rating as number,
        comment: (r.comment ?? null) as string | null,
      }))}
      profileUrl={profileUrl}
    />
  );
}
