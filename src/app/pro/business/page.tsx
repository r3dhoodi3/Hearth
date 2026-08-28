import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { proCtaLabel, proTrialSubline } from "@/components/pro/ProUpgradeCta";
import { buildProStats } from "@/lib/proStats";
import { computeResponseTimeMinutes } from "@/lib/responseTime";
import AccountPanel from "@/components/pro/AccountPanel";
import WinShareButton from "@/components/pro/WinShareButton";
import ReviewShareRow from "@/components/pro/ReviewShareRow";
import {
  labelFor,
  JOB_CATEGORIES,
  GHOST_PROTECTION_DAYS,
  COLD_START_FREE_ALERTS,
} from "@/lib/constants";
import { Lock } from "lucide-react";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

function dollars(cents: number | string | null) {
  const v = Number(cents ?? 0);
  return `$${((Number.isFinite(v) ? v : 0) / 100).toFixed(2)}`;
}

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
  ]);

  // Only a pro who has never held a membership will actually get the trial.
  const trialEligible = !isPro && !proSub;

  const apps = (myApps ?? []) as any[];
  const won = (wonData ?? []) as any[];
  const shareableReviews = reviewRows ?? [];

  // Time to apply: median minutes from job-posted to this pro's application,
  // over their last up to 20 applications. Needs the admin client because most
  // of a pro's application history is against jobs that stayed open or went to
  // another pro, and "leads contractor select" RLS only covers leads currently
  // assigned to them - a user-scoped client can't read those leads' posted-at
  // timestamps. Only timestamps/ids are read here, nothing homeowner-facing.
  const medianApplyMinutes = await computeResponseTimeMinutes(
    createAdminClient(),
    contractor.id
  );
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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">My Business</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Your numbers, your wallet, and everything in flight.
        </p>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Homeowners overwhelmingly pick from the pros who apply first. Fast
          applications win jobs.
        </p>
        {(timeToApplyStat || showApplySpeedNudge) && (
          <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-white/10 dark:bg-stone-800">
            {timeToApplyStat && (
              <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                {timeToApplyStat}
              </p>
            )}
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Jobs usually go to whoever applies first.
            </p>
            {showApplySpeedNudge && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {COLD_START_FREE_ALERTS || isPro ? (
                  "You already get instant alerts the moment a matching job posts, open Hearth as soon as one comes in to keep that edge."
                ) : trialEligible ? (
                  <>
                    <Link href="/pro/plus" className="font-medium underline">
                      {proCtaLabel(true)}
                    </Link>{" "}
                    and turn on instant job alerts, so you see new jobs the
                    moment they post. {proTrialSubline()}
                  </>
                ) : (
                  <>
                    Turn on instant job alerts with a{" "}
                    <Link
                      href="/pro/plus"
                      className="font-medium underline"
                    >
                      Hearth Pro membership
                    </Link>{" "}
                    so you see new jobs the moment they post.
                  </>
                )}
              </p>
            )}
          </div>
        )}
      </div>

      {/* The three numbers a lead-buying business runs on. */}
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="stat-label">Win rate</p>
          <p className="stat-number mt-1 text-2xl">
            {winRate !== null ? `${winRate}%` : "-"}
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {winRate !== null
              ? `${wonCount} won of ${appliedCount} applications`
              : "Shows after 3 applications"}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Spent on applications</p>
          <p className="stat-number mt-1 text-2xl">
            {dollars(spentCents)}
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Refunded automatically when a homeowner never replies (ghost
            protection)
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Cost per job won</p>
          <p className="stat-number mt-1 text-2xl">
            {costPerWin !== null ? dollars(costPerWin) : "-"}
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {costPerWin !== null
              ? "Total spend divided by wins"
              : "Shows after your first win"}
          </p>
        </div>
      </section>

      {/* Wallet snapshot - the full ledger lives on Billing. */}
      <section className="card-hero flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="stat-label">Wallet</p>
          <p className="stat-number mt-1 text-4xl">
            {dollars(cash + bonus)}
          </p>
          <p className="text-xs text-stone-500 dark:text-stone-400 [font-variant-numeric:tabular-nums]">
            {dollars(cash)} cash · {dollars(bonus)} bonus credit
          </p>
        </div>
        <Link href="/pro/billing" className="btn-secondary shrink-0 text-sm">
          Add funds
        </Link>
      </section>

      {/* Account: referral code and the license/insurance compliance
          calendar, folded into one collapsed-by-default panel. The code is
          the pro's public slug when the 0043 migration has run, else the
          first 8 chars of their id (both resolve at onboarding); the
          compliance dates come off migration 0051 columns (insurance_expires
          itself is the older 0033 column). */}
      <AccountPanel
        referralCode={
          ((contractor as any).slug as string | null | undefined) ||
          contractor.id.slice(0, 8)
        }
        license={{
          expires: contractor.license_expires ?? null,
          docPath: contractor.license_doc_path ?? null,
        }}
        // The number and its CSLB result (0037/0055/0125), read off the same
        // columns /pro/profile renders from so the two screens can never
        // disagree about whether a license is on file.
        verification={{
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
        }}
        insurance={{
          expires: (contractor as any).insurance_expires ?? null,
          docPath: contractor.insurance_doc_path ?? null,
        }}
      />

      {/* Insights: the Pro membership's deeper analytics, computed entirely
          from the application rows fetched above. Non-members see the frame
          with masked tiles and one real number as a teaser. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Insights{" "}
            <span className="chip ml-1 bg-hearth-100 align-middle text-hearth-800 dark:bg-hearth-900 dark:text-hearth-200">
              Pro
            </span>
          </h2>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Where your application budget is actually earning its keep.
          </p>
        </div>

        {stats ? (
          <div className="space-y-4">
            {/* Headline tiles: the three numbers that say whether buying
                leads is working. */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="card">
                <p className="stat-label">All-time win rate</p>
                <p className="stat-number mt-1 text-2xl">
                  {stats.winRatePercent !== null
                    ? `${stats.winRatePercent}%`
                    : "-"}
                </p>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {stats.winRatePercent !== null
                    ? `${stats.wins} won of ${stats.liveApplications} paid applications`
                    : "Apply to a job to start tracking"}
                </p>
              </div>
              <div className="card">
                <p className="stat-label">Jobs won</p>
                <p className="stat-number mt-1 text-2xl">
                  {stats.wins}
                </p>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {stats.wins > 0
                    ? `out of ${stats.liveApplications} paid applications`
                    : "No wins yet"}
                </p>
              </div>
              <div className="card">
                <p className="stat-label">Fees spent</p>
                <p className="stat-number mt-1 text-2xl">
                  {dollars(stats.feesSpentCents)}
                </p>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  On leads, net of ghost-protection credits
                </p>
              </div>
            </div>

            <p className="text-xs text-stone-500 dark:text-stone-400">
              {stats.daysSinceLastApplication !== null
                ? `Last application ${
                    stats.daysSinceLastApplication === 0
                      ? "today"
                      : `${stats.daysSinceLastApplication} day${
                          stats.daysSinceLastApplication === 1 ? "" : "s"
                        } ago`
                  }`
                : "No applications yet"}
              {" · "}
              {stats.daysSinceLastWin !== null
                ? `last win ${
                    stats.daysSinceLastWin === 0
                      ? "today"
                      : `${stats.daysSinceLastWin} day${
                          stats.daysSinceLastWin === 1 ? "" : "s"
                        } ago`
                  }`
                : "no wins yet"}
            </p>

            {/* Where the wins come from, category by category. */}
            {stats.categories.length > 0 && (
              <div className="card overflow-x-auto">
                <p className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">
                  By category
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500 dark:text-stone-400">
                      <th className="pb-2 pr-3 font-medium">Category</th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        Apps
                      </th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        Wins
                      </th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        Win rate
                      </th>
                      <th className="pb-2 text-right font-medium">Avg fee</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                    {stats.categories.map((c) => (
                      <tr key={c.category}>
                        <td className="py-2 pr-3 font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(JOB_CATEGORIES, c.category)}
                        </td>
                        <td className="py-2 pr-3 text-right text-stone-600 dark:text-stone-300">
                          {c.applications}
                        </td>
                        <td className="py-2 pr-3 text-right text-stone-600 dark:text-stone-300">
                          {c.wins}
                        </td>
                        <td className="py-2 pr-3 text-right text-stone-600 dark:text-stone-300">
                          {c.winRatePercent !== null
                            ? `${c.winRatePercent}%`
                            : "-"}
                        </td>
                        <td className="py-2 text-right text-stone-600 dark:text-stone-300">
                          {c.avgFeeCents !== null
                            ? dollars(c.avgFeeCents)
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Six-month rhythm: applications in, wins out. */}
            <div className="card space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-stone-500 dark:text-stone-400">
                  Last 6 months
                </p>
                <p className="flex items-center gap-3 text-[10px] text-stone-500 dark:text-stone-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-hearth-500 dark:bg-hearth-400" />
                    Applications
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-stone-300 dark:bg-stone-500" />
                    Wins
                  </span>
                </p>
              </div>
              <div className="overflow-x-auto pb-1">
                <div className="flex items-end gap-2 border-b border-stone-200 dark:border-white/10">
                  {stats.trend.map((m, i) => {
                    const appHeight =
                      m.applications > 0
                        ? Math.max(
                            6,
                            Math.round((m.applications / trendMax) * 96)
                          )
                        : 3;
                    const winHeight =
                      m.wins > 0
                        ? Math.max(6, Math.round((m.wins / trendMax) * 96))
                        : 3;
                    const isCurrent = i === stats.trend.length - 1;
                    return (
                      <div
                        key={m.key}
                        title={`${m.label}: ${m.applications} application${
                          m.applications === 1 ? "" : "s"
                        }, ${m.wins} won`}
                        className="flex min-w-[2.5rem] flex-col items-center gap-1 transition hover:opacity-90"
                      >
                        <span className="text-[10px] text-stone-500 dark:text-stone-400">
                          {m.applications > 0 ? m.applications : ""}
                        </span>
                        <div className="flex items-end gap-0.5">
                          <div
                            className={`w-3 rounded-t-md ${
                              m.applications > 0
                                ? isCurrent
                                  ? "bg-hearth-600 dark:bg-hearth-500"
                                  : "bg-hearth-400 dark:bg-hearth-500/60"
                                : "bg-stone-100 dark:bg-stone-700"
                            }`}
                            style={{ height: `${appHeight}px` }}
                          />
                          <div
                            className={`w-3 rounded-t-md ${
                              m.wins > 0 ? "bg-stone-300 dark:bg-stone-500" : "bg-stone-100 dark:bg-stone-700"
                            }`}
                            style={{ height: `${winHeight}px` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1 flex gap-2">
                  {stats.trend.map((m) => (
                    <span
                      key={m.key}
                      className="min-w-[2.5rem] text-center text-[10px] text-stone-500 dark:text-stone-400"
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Teaser. The old version masked "All-time win rate" and "Fees
                spent" - both of which are printed in full, unmasked, in the
                three stat cards at the top of this same page, so the lock was
                over a door with no wall. What Insights actually adds is the
                per-CATEGORY split, so that is what gets teased: the pro's own
                trades by name, with the two numbers they cannot see yet. */}
            {teaserCategories.length > 0 && (
              <div className="card overflow-x-auto">
                <p className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">
                  Which of your trades actually pays? Included with Hearth Pro.
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500 dark:text-stone-400">
                      <th className="pb-2 pr-3 font-medium">Category</th>
                      <th className="pb-2 pr-3 text-right font-medium">Apps</th>
                      <th className="pb-2 pr-3 text-right font-medium">
                        Win rate
                      </th>
                      <th className="pb-2 text-right font-medium">Avg fee</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                    {teaserCategories.map((c) => (
                      <tr key={c.category}>
                        <td className="py-2 pr-3 font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(JOB_CATEGORIES, c.category)}
                        </td>
                        <td className="py-2 pr-3 text-right text-stone-600 dark:text-stone-300">
                          {c.applications}
                        </td>
                        {/* Placeholder glyphs, not the real figure under a
                            blur. Decorative, so hidden from screen readers. */}
                        <td
                          aria-hidden="true"
                          className="select-none py-2 pr-3 text-right text-stone-300 blur-[3px] dark:text-stone-600"
                        >
                          --%
                        </td>
                        <td
                          aria-hidden="true"
                          className="select-none py-2 text-right text-stone-300 blur-[3px] dark:text-stone-600"
                        >
                          $--
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                  <span aria-hidden="true" className="icon-chip">
                    <Lock className="h-5 w-5" />
                  </span>
                  Win rate and average fee per category
                </p>
              </div>
            )}
            <p className="text-sm text-stone-500 dark:text-stone-400">
              {spentCents > 0
                ? `You've spent ${dollars(spentCents)} on application fees - Insights shows which categories are earning it back. `
                : "Insights shows which categories earn your application fees back, and which ones quietly drain them. "}
              <Link
                href="/pro/plus"
                className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
              >
                {trialEligible
                  ? `${proCtaLabel(true)} and unlock Insights`
                  : "Unlock Insights with Hearth Pro"}
              </Link>
              .{trialEligible ? ` ${proTrialSubline()}` : ""}
            </p>
          </div>
        )}
      </section>

      {/* In flight: applications waiting on a homeowner, with the credit clock. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Pending applications{" "}
            <span className="text-stone-500 dark:text-stone-400">({pendingApps.length})</span>
          </h2>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Ghost protection: if the homeowner never responds, your fee comes
            back automatically as wallet credit.
          </p>
        </div>
        {pendingApps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            Nothing in flight.{" "}
            <Link
              href="/pro"
              className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
            >
              Browse open jobs
            </Link>{" "}
            and apply while they&apos;re fresh: new postings close best.
          </p>
        ) : (
          <ul className="space-y-2">
            {pendingApps.map((a) => {
              const daysLeft = refundDaysLeft(a.applied_at);
              return (
                <li
                  key={a.application_id}
                  className="card flex items-center justify-between gap-3"
                >
                  <div>
                    <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                      {labelFor(JOB_CATEGORIES, a.category)}
                    </span>
                    {a.issue_description && (
                      <p className="text-sm text-stone-500 dark:text-stone-400">
                        {a.issue_description}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-right text-xs text-stone-500 dark:text-stone-400">
                    {daysLeft === 0
                      ? "Fee comes back as credit today if no response"
                      : `Fee comes back as credit in ${daysLeft} day${
                          daysLeft === 1 ? "" : "s"
                        } if no response`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Recent wins - the payoff column. Share-worthy reviews fold in here
          too (id="share-reviews" is where the new-review notification
          links), rather than opening a whole new section for them. */}
      <section id="share-reviews" className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Jobs won <span className="text-stone-500 dark:text-stone-400">({won.length})</span>
        </h2>
        {won.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            No wins yet. Specific, fast replies are what turn applications into
            jobs: the{" "}
            <Link
              href="/pro/playbook"
              className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
            >
              Playbook
            </Link>{" "}
            has the short version.
          </p>
        ) : (
          <ul className="space-y-2">
            {won.map((l) => (
              <li
                key={l.id}
                className="card flex flex-wrap items-center justify-between gap-3"
              >
                <span className="flex min-w-0 items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                  {labelFor(JOB_CATEGORIES, l.category)}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {STATUS_LABEL[l.status] ?? l.status} ·{" "}
                    {new Date(l.created_at).toLocaleDateString()}
                  </span>
                  {/* This recent-leads query isn't filtered to won rows, so
                      the button only shows for one that actually is: paid,
                      or accepted / closed in the pipeline. */}
                  {(l.paid || l.status === "accepted" || l.status === "closed") && (
                    <WinShareButton leadId={l.id} businessName={contractor.name} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Share your reviews: every 4 or 5 star review gets a ready-made
            card + caption. Same >= 4 star floor as review-card's own 404
            check, so nothing offered here can 404 when clicked. */}
        {shareableReviews.length > 0 && (
          <div className="border-t border-stone-100 pt-4 dark:border-white/10">
            <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Share your reviews
            </h3>
            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
              Turn a great review into a share card and a ready-to-post
              caption.
            </p>
            <ul className="mt-2 space-y-2">
              {shareableReviews.map((r) => (
                <ReviewShareRow
                  key={r.id}
                  reviewId={r.id}
                  rating={r.rating}
                  comment={r.comment}
                  profileUrl={profileUrl}
                />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
