"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/app/pro/leads/LeadsBoard.tsx, src/app/pro/chats/ChatsView.tsx,
// src/app/pro/help/HelpView.tsx and src/app/pro/billing/BillingView.tsx,
// investigated in scratchpad/debug-DBG3.md.
//
// React Flight defers any element it meets once the row it is serializing has
// passed a 3200-byte budget: it writes "$L<id>" in place and starts a fresh
// row for that element. Fizz then has to stream each of those rows as an
// out-of-order segment - a <template id="P:n"> hole nested inside the page's
// own markup plus a late $RS(...) script to fill it - and that hole chain is
// the shape that comes with the React #418 / "$RS ... parentNode" hydration
// failure reported on the pro pages.
//
// /pro/business measured one deferral on live (2026-08-30): the "Jobs won"
// section, chopped off the tail of the page row at byte ~4340. This page is
// long, so whatever renders last always takes that cut - the fix is to leave
// nothing behind at all.
//
// As one client module the whole body becomes a SINGLE client reference in the
// page's payload carrying plain data, so there is no element left anywhere in
// that row for Flight to defer.
//
// Nothing here is newly interactive and nothing is newly computed on the
// client. PushSettingsCard, AccountPanel, WinShareButton, ReviewShareRow and
// next/link were already client components; the rest is static markup rendered
// from props. Everything that reads the clock or the locale - the ghost-
// protection countdown on a pending application, the date on a won job - is
// resolved on the server and arrives here as a finished string, so hydration
// cannot disagree with SSR about it. `dollars` is plain arithmetic with a
// fixed two-decimal format, no locale involved, so it renders identically on
// both sides.

import Link from "next/link";
import { Lock } from "lucide-react";
import { proCtaLabel, proTrialSubline } from "@/components/pro/ProUpgradeCta";
import type { ProStats } from "@/lib/proStats";
import AccountPanel from "@/components/pro/AccountPanel";
import PushSettingsCard from "@/components/PushSettingsCard";
import WinShareButton from "@/components/pro/WinShareButton";
import ReviewShareRow from "@/components/pro/ReviewShareRow";
import PrintQrButton from "./PrintQrButton";
import WonReferralNudge from "./WonReferralNudge";
import {
  labelFor,
  JOB_CATEGORIES,
  COLD_START_FREE_ALERTS,
  PRO_LEADS_HREF,
} from "@/lib/constants";

function dollars(cents: number | string | null) {
  const v = Number(cents ?? 0);
  return `$${((Number.isFinite(v) ? v : 0) / 100).toFixed(2)}`;
}

/** One application still waiting on a homeowner. */
export type PendingAppVM = {
  applicationId: string;
  categoryLabel: string;
  description: string | null;
  /** Ghost-protection countdown, resolved on the server: it reads the clock. */
  refundLine: string;
};

/** One job this pro won. */
export type WonJobVM = {
  id: string;
  categoryLabel: string;
  /** "Won · 8/14/2026", both halves resolved on the server. */
  metaLine: string;
  /** Only a genuine win gets a share card offered. */
  shareable: boolean;
};

/** One review worth sharing (4 stars and up). */
export type ShareReviewVM = {
  id: string;
  rating: number;
  comment: string | null;
};

/** Everything the collapsed Account panel needs, straight off the row. */
export type AccountPanelProps = React.ComponentProps<typeof AccountPanel>;

export default function BusinessView({
  timeToApplyStat,
  showApplySpeedNudge,
  isPro,
  trialEligible,
  winRate,
  wonCount,
  appliedCount,
  spentCents,
  costPerWin,
  cashCents,
  bonusCents,
  account,
  stats,
  trendMax,
  teaserCategories,
  pendingApps,
  wonJobs,
  businessName,
  shareableReviews,
  profileUrl,
}: {
  timeToApplyStat: string | null;
  showApplySpeedNudge: boolean;
  isPro: boolean;
  trialEligible: boolean;
  winRate: number | null;
  wonCount: number;
  appliedCount: number;
  spentCents: number;
  costPerWin: number | null;
  cashCents: number;
  bonusCents: number;
  account: AccountPanelProps;
  /** Pro members only; null renders the teaser instead. */
  stats: ProStats | null;
  trendMax: number;
  teaserCategories: Array<{ category: string; applications: number }>;
  pendingApps: PendingAppVM[];
  wonJobs: WonJobVM[];
  businessName: string;
  shareableReviews: ShareReviewVM[];
  profileUrl: string;
}) {
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
            {dollars(cashCents + bonusCents)}
          </p>
          <p className="text-xs text-stone-500 dark:text-stone-400 [font-variant-numeric:tabular-nums]">
            {dollars(cashCents)} cash · {dollars(bonusCents)} bonus credit
          </p>
        </div>
        <Link href="/pro/billing" className="btn-secondary shrink-0 text-sm">
          Add funds
        </Link>
      </section>

      {/* Phone notifications. Top level rather than inside the collapsed
          Account panel below, and here rather than on a notification settings
          page, because the pro side has no such page: /pro/business is where a
          contractor's own settings live. This is the only control that reaches
          a pro with the app closed, and speed to lead is the whole pro-side
          product, so burying it one disclosure triangle down would cost the
          feature most of its point. Renders nothing at all when the deployment
          has no VAPID keys or the browser cannot do push. */}
      <PushSettingsCard side="pro" />

      {/* MR3#12, pro side: one-time nudge toward the referral card after the
          first Won lead - see WonReferralNudge.tsx for the once-per-account
          rule and why #account (below) is enough to both scroll to and open
          the collapsed panel it links into. */}
      <WonReferralNudge wonCount={wonCount} />

      {/* Account: referral code and the license/insurance compliance
          calendar, folded into one collapsed-by-default panel. The code is
          the pro's public slug when the 0043 migration has run, else the
          first 8 chars of their id (both resolve at onboarding); the
          compliance dates come off migration 0051 columns (insurance_expires
          itself is the older 0033 column). Every field is read on the server
          and spread in here as plain data. */}
      <AccountPanel {...account} />

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
                {/* 12px below sm, not 14px: this legend sits inside a
                    width-bound chart where 14px overlaps the bars. It is the
                    one place on the pro side that stops at 12px, and it is
                    still a 20% lift from 10px. */}
                <p className="flex items-center gap-3 text-[10px] text-stone-500 max-sm:text-xs dark:text-stone-400">
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
                        <span className="text-[10px] text-stone-500 max-sm:text-xs dark:text-stone-400">
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
                      className="min-w-[2.5rem] text-center text-[10px] text-stone-500 max-sm:text-xs dark:text-stone-400"
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
          {/* "Lead credit (not cash)" bolded on request: this line used to say
              "wallet credit" alone, which a pro skimming past could still
              read as money back to a card. */}
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Ghost protection: if the homeowner never responds, your fee comes
            back automatically as <strong>lead credit (not cash)</strong>.
          </p>
        </div>
        {pendingApps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            Nothing in flight.{" "}
            <Link
              href={PRO_LEADS_HREF}
              className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
            >
              Browse open jobs
            </Link>{" "}
            and apply while they&apos;re fresh: new postings close best.
          </p>
        ) : (
          <ul className="space-y-2">
            {pendingApps.map((a) => (
              <li
                key={a.applicationId}
                className="card flex items-center justify-between gap-3"
              >
                <div>
                  <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                    {a.categoryLabel}
                  </span>
                  {a.description && (
                    <p className="text-sm text-stone-500 dark:text-stone-400">
                      {a.description}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-right text-xs text-stone-500 dark:text-stone-400">
                  {a.refundLine}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent wins - the payoff column. Share-worthy reviews fold in here
          too (id="share-reviews" is where the new-review notification
          links), rather than opening a whole new section for them. */}
      <section id="share-reviews" className="space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          Jobs won <span className="text-stone-500 dark:text-stone-400">({wonJobs.length})</span>
        </h2>
        {wonJobs.length === 0 ? (
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
            {wonJobs.map((l) => (
              <li
                key={l.id}
                className="card flex flex-wrap items-center justify-between gap-3"
              >
                <span className="flex min-w-0 items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                  {l.categoryLabel}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {l.metaLine}
                  </span>
                  {/* This recent-leads query isn't filtered to won rows, so
                      the button only shows for one that actually is: paid,
                      or accepted / closed in the pipeline. */}
                  {l.shareable && (
                    <WinShareButton leadId={l.id} businessName={businessName} />
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

        {/* CR4#3: a printable QR + link + business name PNG, offline
            distribution with zero ad spend - every scan is already a warm,
            local lead. */}
        <PrintQrButton url={profileUrl} businessName={businessName} />
      </section>
    </div>
  );
}
