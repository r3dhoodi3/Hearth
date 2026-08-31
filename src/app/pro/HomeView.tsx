"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/app/pro/leads/LeadsBoard.tsx, src/app/pro/chats/ChatsView.tsx,
// src/app/pro/help/HelpView.tsx, src/app/pro/billing/BillingView.tsx and
// src/app/pro/business/BusinessView.tsx, investigated in
// scratchpad/debug-DBG3.md.
//
// React Flight defers any element it meets once the row it is serializing has
// passed a 3200-byte budget: it writes "$L<id>" in place and starts a fresh
// row for that element. Fizz then has to stream each of those rows as an
// out-of-order segment - a <template id="P:n"> hole nested inside the page's
// own markup plus a late $RS(...) script to fill it - and that hole chain is
// the shape that comes with the React #418 / "$RS ... parentNode" hydration
// failure reported on the pro pages.
//
// Making SetupChecklist a client component (DBG3's first fix) took /pro from
// eight nested holes to one. It did not take the DEFERRALS to zero: measured
// live on 2026-08-30 the page row still cut the entire two-column lower half
// of the page - everything from "Asked for you" down - into a row of its own,
// because the greeting, the quick actions and the three tool tiles above it
// had already spent the budget by byte ~4590. The lower half is not the
// problem; whatever renders after the budget runs out is.
//
// As one client module the whole body becomes a SINGLE client reference in the
// page's payload carrying plain data, so there is no element left anywhere in
// that row for Flight to defer.
//
// Nothing here is newly interactive and nothing is newly computed on the
// client. LeadsRealtime, ChatDrawer, ClearOnboardingDraft, DirectRequestCard,
// SetupChecklist, ProNudge, ProChip, LiveUnreadBadge and next/link were
// already client components; the rest is static markup rendered from props.
// Everything that reads the clock or the locale - the greeting's time of day,
// the subtitle's counts, each direct request's posted-ago line - is resolved
// on the server and arrives here as a finished string, so hydration cannot
// disagree with SSR about it.

import Link from "next/link";
import {
  ClipboardList,
  TrendingUp,
  BookOpen,
  MessageCircle,
  Search,
} from "lucide-react";
import { PRO_LEADS_HREF, PRO_DEPOSIT_BOOST_PTS } from "@/lib/constants";
import {
  FEEDBACK_CARD_TITLE,
  FEEDBACK_LOCKED_NOTE,
  feedbackCreditDollars,
} from "@/lib/proFeedback";
import SetupChecklist, { type SetupItem } from "@/components/pro/SetupChecklist";
import ProChip from "@/components/pro/ProChip";
import ProNudge from "@/components/pro/ProNudge";
import LiveUnreadBadge from "@/components/LiveUnreadBadge";
import LeadsRealtime from "./LeadsRealtime";
import ChatDrawer from "@/components/ChatDrawer";
import ClearOnboardingDraft from "./ClearOnboardingDraft";
import DirectRequestCard from "./DirectRequestCard";

/** One direct request, with its clock-dependent line already resolved. */
export type HomeDirectItem = {
  id: string;
  /** The raw RPC row the card already took; plain JSON either way. */
  row: any;
  postedAgoLabel: string | null;
};

/** One "Latest" notification row. */
export type LatestRow = { id: string; title: string; href: string };

/** A license/insurance renewal chip. */
export type ExpiryChip = { label: string; href: string; overdue: boolean };

export default function HomeView({
  contractorId,
  userId,
  greeting,
  subtitle,
  expiring,
  member,
  directRequests,
  directRequestCount,
  showSeeAll,
  balance,
  hasPaidMajor,
  insuranceCurrent,
  openCount,
  activeCount,
  appliedCount,
  wonCount,
  trend,
  feedbackClaimed,
  feedbackSent,
  established,
  showNudge,
  nudgeTrialEligible,
  latestRows,
  setupItems,
}: {
  contractorId: string;
  userId: string;
  /** "Good morning, Sam" - the hour is read on the server. */
  greeting: string;
  subtitle: string;
  expiring: ExpiryChip[];
  member: boolean;
  /** Already sliced to the preview length on the server. */
  directRequests: HomeDirectItem[];
  /** The FULL count, printed next to the heading. */
  directRequestCount: number;
  /** True when there are more requests than the preview shows. */
  showSeeAll: boolean;
  balance: number;
  hasPaidMajor: boolean;
  /** Whether this pro has current insurance on file (0153), for the big-job gate on direct-request cards. */
  insuranceCurrent: boolean;
  openCount: number;
  activeCount: number;
  appliedCount: number;
  wonCount: number;
  /** Six-month totals; null for a non-member, who gets the pitch instead. */
  trend: { applications: number; wins: number } | null;
  feedbackClaimed: boolean;
  feedbackSent: boolean;
  established: boolean;
  showNudge: boolean;
  nudgeTrialEligible: boolean;
  latestRows: LatestRow[];
  setupItems: SetupItem[];
}) {
  return (
    <div className="space-y-6">
      {/* The board's realtime subscription and the chat drawer both belong to
          the shell rather than to the board: a new job should light the tab
          bar while the pro is sitting on Home. */}
      <LeadsRealtime contractorId={contractorId} />
      <ChatDrawer role="contractor" />
      {/* Reaching this page means a contractors row exists, which is the only
          honest proof the signup wizard's save actually landed - so this is
          where its localStorage draft finally gets dropped. Renders nothing. */}
      <ClearOnboardingDraft userId={userId} />

      {/* ---- Greeting: who you are and what is waiting ---- */}
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {greeting}
        </h1>
        {/* Never a slogan: this sentence is built from counts, and says
            "Nothing waiting on you right now." when there are none. */}
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          {subtitle}
        </p>
        {expiring.length > 0 && (
          // Renewal countdown, only inside 45 days. Hidden the rest of the
          // year, which is almost always.
          <div className="mt-3 flex flex-wrap gap-2">
            {expiring.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                className={`chip inline-flex min-h-11 items-center border ${
                  c.overdue
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300"
                    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
                }`}
              >
                {c.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ---- Quick actions: the two things a pro opens the app to do ---- */}
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <Link
          href={PRO_LEADS_HREF}
          className="btn-primary flex items-center justify-center gap-2"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          Find jobs
        </Link>
        <Link
          href="/pro/chats"
          className="btn-secondary flex items-center justify-center gap-2"
        >
          <MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Messages
          {/* The same badge the Messages tab carries, from the same source, so
              the two can never disagree. */}
          <LiveUnreadBadge role="contractor" />
        </Link>
      </div>

      {/* ---- Three tools, the pro twin of the homeowner dashboard's row ----
          Same classes, same grid, same tile shape. Titles shorten below sm so
          three fit across at 390px without wrapping to three lines.
          `chip` says what a non-member sees before tapping, never after:
          "pro" is the hearth-accent gate for a tile that is truly member-only
          (the insights trend on /pro/business), "free" is the green two-free-
          drafts tag for the back office (0145 gave every contractor two free
          drafts before it gates, so a "Pro" chip there overstated the door),
          and null (the playbook, free for everyone) wears nothing. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[
          {
            href: "/pro/tools",
            icon: ClipboardList,
            title: "Write an estimate",
            shortTitle: "Estimate",
            line: "Drafts your paperwork",
            chip: "free" as const,
          },
          {
            href: "/pro/business",
            icon: TrendingUp,
            title: "Your numbers",
            shortTitle: "Numbers",
            line: "Win rate and spend",
            chip: "pro" as const,
          },
          {
            href: "/pro/playbook",
            icon: BookOpen,
            title: "Playbook",
            shortTitle: "Playbook",
            line: "How to win more",
            chip: null,
          },
        ].map((t) => (
          <Link key={t.title} href={t.href} className="card-link p-3 text-center">
            <p className="icon-chip">
              <t.icon className="h-5 w-5" aria-hidden="true" />
            </p>
            <p className="mt-1.5 text-xs font-medium text-stone-900 dark:text-stone-100 sm:text-sm">
              <span className="sm:hidden">{t.shortTitle}</span>
              <span className="hidden sm:inline">{t.title}</span>
            </p>
            {!member && t.chip === "pro" && (
              <p className="mt-0.5 flex flex-wrap justify-center gap-1">
                <ProChip />
              </p>
            )}
            {/* Static, not the live free_tool_drafts_used count: reading that
                counter costs its own query (src/lib/freeAiTasteServer.ts's
                proDraftsLeft, an admin-client round trip this already-lean
                Home render does not otherwise make), and this tile's job is
                just to say the door opens for free at all. /pro/tools shows
                the exact number left once a pro is actually there. */}
            {!member && t.chip === "free" && (
              <p className="mt-0.5 flex flex-wrap justify-center gap-1">
                <ProChip tone="free" label="Free to try" />
              </p>
            )}
            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
              {t.line}
            </p>
          </Link>
        ))}
      </div>

      {/* Everything below sits in two columns from sm up and one on a phone.
          Nothing fancy: the same blocks, side by side where there is room. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* ---- Asked for you: the exclusive stuff, first ---- */}
        {directRequestCount > 0 && (
          <section className="space-y-3 sm:col-span-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                  Asked for you{" "}
                  <span className="text-stone-500 dark:text-stone-400">
                    ({directRequestCount})
                  </span>
                </h2>
                <p className="text-sm text-stone-500 dark:text-stone-400">
                  A homeowner reached out to you directly. Only you can see
                  these.
                </p>
              </div>
              {showSeeAll && (
                <Link
                  href={PRO_LEADS_HREF}
                  className="text-sm font-medium text-hearth-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
                >
                  See all
                </Link>
              )}
            </div>
            <ul className="space-y-3">
              {/* The same card the Leads board renders, not a second copy of
                  it: see src/app/pro/DirectRequestCard.tsx. */}
              {directRequests.map((d) => (
                <DirectRequestCard
                  key={d.id}
                  d={d.row}
                  balance={balance}
                  hasPaidMajor={hasPaidMajor}
                  hasCurrentInsurance={insuranceCurrent}
                  // Resolved on the server, not in the card: this line reads
                  // the clock, so it has to be settled there or hydration
                  // could disagree with SSR.
                  postedAgoLabel={d.postedAgoLabel}
                />
              ))}
            </ul>
          </section>
        )}

        {/* ---- Today's numbers ---- */}
        <section className="space-y-3 sm:col-span-2">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Today
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Link
              href="/pro/billing"
              className="card-link hover:border-hearth-400 dark:hover:border-hearth-400"
            >
              <p className="stat-label">Wallet</p>
              <p className="stat-number mt-1 text-2xl text-stone-900 dark:text-stone-100">
                ${balance.toFixed(2)}
              </p>
            </Link>
            <Link
              href={PRO_LEADS_HREF}
              className="card-link hover:border-hearth-400 dark:hover:border-hearth-400"
            >
              <p className="stat-label">Open jobs</p>
              <p className="stat-number mt-1 text-2xl text-stone-900 dark:text-stone-100">
                {openCount}
              </p>
            </Link>
            {/* MED-2: this used to link to /pro/crm, a separate opt-in
                client tracker with its own dataset - confusing, since the
                count here (activeCount, computed in page.tsx from `assigned`
                filtered to non-closed/lost) has nothing to do with what
                /pro/crm shows. Points at the "Your jobs" section on the
                leads board instead, the list this stat actually counts. */}
            <Link
              href={`${PRO_LEADS_HREF}#your-jobs`}
              className="card-link hover:border-hearth-400 dark:hover:border-hearth-400"
            >
              <p className="stat-label">Active jobs</p>
              <p className="stat-number mt-1 text-2xl text-stone-900 dark:text-stone-100">
                {activeCount}
              </p>
            </Link>
            {/* Win rate needs enough applications to mean anything; below
                three it says how many are in flight instead of printing a
                percentage off one or two rolls of the dice. Same floor the
                leads board's results hero uses. */}
            <Link
              href="/pro/business"
              className="card-link hover:border-hearth-400 dark:hover:border-hearth-400"
            >
              <p className="stat-label">
                {appliedCount >= 3 ? "Win rate" : "Applications"}
              </p>
              <p className="stat-number mt-1 text-2xl text-stone-900 dark:text-stone-100">
                {appliedCount >= 3
                  ? `${Math.round((wonCount / appliedCount) * 100)}%`
                  : appliedCount}
              </p>
            </Link>
          </div>
        </section>

        {/* ---- The trend that already exists on the Business page ---- */}
        <section className="card space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Last 6 months
            </h2>
            {!member && <ProChip />}
          </div>
          {trend ? (
            <>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {/* The same two counts /pro/business charts, summed over the
                    same six-month window, from the same buildProStats call.
                    One sentence here, the chart there. */}
                {trend.applications}{" "}
                application
                {trend.applications === 1 ? "" : "s"}
                , {trend.wins} won.
              </p>
              <Link
                href="/pro/business"
                className="inline-flex text-sm font-medium text-hearth-700 hover:underline max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
              >
                See the breakdown
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Which of your trades actually pays, month by month, and what
                each win really costs you.
              </p>
              <Link
                href="/pro/plus?reason=leads"
                className="inline-flex text-sm font-medium text-hearth-700 hover:underline max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
              >
                See Hearth Pro
              </Link>
            </>
          )}
        </section>

        {/* ---- Feedback credit ---- */}
        <section className="card space-y-2">
          {feedbackClaimed ? (
            <>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Thank you for your feedback
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {feedbackCreditDollars()} in lead credit has been added to your
                wallet.
              </p>
              <Link
                href="/pro/billing"
                className="inline-flex text-sm font-medium text-hearth-700 hover:underline max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
              >
                See it in your wallet
              </Link>
              {/* The money was once-ever; the reports are not. Keep the door
                  to /pro/feedback open after the credit is collected. */}
              <Link
                href="/pro/feedback"
                className="inline-flex text-sm font-medium text-hearth-700 hover:underline max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
              >
                Report a bug
              </Link>
            </>
          ) : feedbackSent ? (
            <>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Thanks for the feedback
              </h2>
              {/* Sent, not yet earned: say exactly what unlocks it rather than
                  leaving a promise hanging. The grant runs on its own the next
                  time this page loads after they qualify. */}
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Your {feedbackCreditDollars()} in lead credit will be added once
                your license is confirmed or you place your first lead.
              </p>
              <Link
                href="/pro/feedback"
                className="inline-flex text-sm font-medium text-hearth-700 hover:underline max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
              >
                Report another bug
              </Link>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                {FEEDBACK_CARD_TITLE}
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                It takes about a minute: a score from 1 to 5 and a few words. We read every message.
              </p>
              {!established && (
                <p className="text-sm text-stone-500 dark:text-stone-400">
                  {FEEDBACK_LOCKED_NOTE}
                </p>
              )}
              <Link
                href="/pro/feedback"
                className="btn-secondary mt-1 inline-block text-sm"
              >
                Report a bug
              </Link>
            </>
          )}
        </section>

        {/* ---- Membership nudge: established non-members only ---- */}
        {showNudge && (
          <div className="sm:col-span-2">
            <ProNudge
              userId={userId}
              trialEligible={nudgeTrialEligible}
              depositBoostPts={PRO_DEPOSIT_BOOST_PTS}
              // $10 a cycle, mirroring grant_membership_credit in the Stripe
              // webhook. Kept next to the perk copy on /pro/plus.
              monthlyCreditDollars={10}
            />
          </div>
        )}

        {/* ---- Latest: what actually happened, newest first ---- */}
        {latestRows.length > 0 && (
          <section className="card space-y-2 sm:col-span-2">
            <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Latest
            </h2>
            <ul className="space-y-1">
              {latestRows.map((r) => (
                <li key={r.id}>
                  <Link
                    href={r.href}
                    className="flex min-h-11 items-center text-sm text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-stone-100"
                  >
                    {r.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ---- Setup checklist, until it is done ---- */}
        <div className="sm:col-span-2">
          <SetupChecklist items={setupItems} />
        </div>
      </div>
    </div>
  );
}
