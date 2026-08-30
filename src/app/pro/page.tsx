import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ClipboardList,
  TrendingUp,
  BookOpen,
  MessageCircle,
  Search,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import {
  PRO_LEADS_HREF,
  PRO_DEPOSIT_BOOST_PTS,
  isMajorCategory,
} from "@/lib/constants";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { getOpenJobsForMe } from "@/lib/greeting";
import {
  walletQueryPlan,
  closedLeadIdSet,
  bonusAvailableCents,
} from "@/lib/proDashboard";
import {
  buildSetupItems,
  expiryChips,
  greetingForHour,
  homeSubtitle,
} from "@/lib/proHome";
import { countAwaitingReply } from "@/lib/proHomeServer";
import { buildProStats } from "@/lib/proStats";
import {
  FEEDBACK_CARD_TITLE,
  FEEDBACK_LOCKED_NOTE,
  feedbackCreditDollars,
} from "@/lib/proFeedback";
import { readFeedbackState, grantFeedbackCredit } from "@/lib/proFeedbackServer";
import SetupChecklist from "@/components/pro/SetupChecklist";
import ProChip from "@/components/pro/ProChip";
import ProNudge from "@/components/pro/ProNudge";
import LiveUnreadBadge from "@/components/LiveUnreadBadge";
import LeadsRealtime from "./LeadsRealtime";
import ChatDrawer from "@/components/ChatDrawer";
import ClearOnboardingDraft from "./ClearOnboardingDraft";
import DirectRequestCard from "./DirectRequestCard";

// The pro HOME tab.
//
// The pro side used to open straight onto the leads board, which is a working
// screen: a wall of job cards, sort controls and fee maths before you have even
// said hello. The owner asked for a home that "feels more homey", so the board
// moved to its own tab (/pro/leads, PRO_LEADS_HREF) and this is what a pro
// lands on: what is waiting on them today, the two things they most often came
// here to do, their own numbers, and the setup they have not finished.
//
// It buys no new data. Every block below is computed from the same five reads
// the leads board already made, plus one small bounded message query for the
// "waiting on your reply" count. Nothing here is a slogan: every sentence is a
// count of something real, and when there is nothing, it says so.

// How many "Asked for you" cards the preview shows before sending the pro to
// the full list. Two: enough to be a real answer, short enough that the Home
// tab does not become a second leads board.
const DIRECT_PREVIEW = 2;

export default async function ProHome() {
  const contractor = await getCurrentContractor();
  // No company yet: finish company setup. Same rule the leads board has always
  // had - anyone who reached this URL is asking for the pro side, and building
  // a company is how you get one.
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();

  // FIRST ROUND TRIP. The same helpers and the same shapes the leads board
  // uses, so a pro who taps through to Leads pays for nothing twice:
  // getOpenJobsForMe is request-cached, and my_applications / my_direct_requests
  // are the same RPCs.
  const [
    openJobs,
    { data: myApps },
    { data: assignedData },
    { data: directData },
    { data: wallet },
  ] = await Promise.all([
    getOpenJobsForMe(),
    (supabase as any).rpc("my_applications"),
    (async () => {
      // Only what this page counts and links to: status for the active-jobs
      // number, id for the message lookup below. The board's full column set
      // (contact details, photos, scope) is not needed on Home.
      const res = await (supabase as any)
        .from("contractor_leads")
        .select("id, status")
        .eq("contractor_id", contractor.id);
      return res;
    })(),
    (supabase as any).rpc("my_direct_requests"),
    (supabase as any)
      .from("wallets")
      .select("id, cash_balance_cents, bonus_balance_cents")
      .eq("contractor_id", contractor.id)
      .maybeSingle(),
  ]);

  let open = (openJobs ?? []) as any[];
  const apps = (myApps ?? []) as any[];
  const directRequests = (directData ?? []) as any[];
  const assigned = (assignedData ?? []) as any[];
  const rawBonusCents = Number(wallet?.bonus_balance_cents ?? 0);
  const walletReads = walletQueryPlan(wallet, rawBonusCents);

  // SECOND ROUND TRIP: everything that needed a result from the first.
  const [closedRows, grants, awaitingReply, member, latestRows] = await Promise.all([
    // Same advisory sweep the board does (migration 0092's RESIDUAL note):
    // open_jobs_for_me can hand back a job the homeowner already closed
    // without picking anyone. The greeting prints this count, so it has to be
    // the same number the board will show. Best effort and fail-open: an
    // error leaves the count alone rather than hiding jobs.
    open.length
      ? (async () => {
          const admin = createAdminClient();
          const { data, error } = await admin
            .from("contractor_leads")
            .select("id, owner_closed_at")
            .in(
              "id",
              open.map((j) => j.id)
            );
          return error ? null : ((data ?? []) as any[]);
        })()
      : Promise.resolve(null),
    // Live, unexpired bonus grants, which cap the spendable bonus below.
    walletReads.grants
      ? (async () => {
          const { data } = await (supabase as any)
            .from("bonus_grants")
            .select("remaining_cents")
            .eq("wallet_id", wallet.id)
            .gt("remaining_cents", 0)
            .gt("expires_at", new Date().toISOString());
          return (data ?? []) as any[];
        })()
      : Promise.resolve([] as any[]),
    countAwaitingReply(assigned.map((l) => l.id)),
    hasProPlan(),
    // "Latest": the three newest things that happened to this pro. Read from
    // the notifications table the bell already uses, filtered to pro-side rows
    // by their url, because on a dual-side account the same table also holds
    // that person's homeowner notifications. RLS scopes it to their own rows,
    // so no user filter is needed here. Best effort: an error renders nothing.
    (async () => {
      const { data } = await (supabase as any)
        .from("notifications")
        .select("id, title, url, created_at")
        .like("url", "/pro%")
        .order("created_at", { ascending: false })
        .limit(3);
      return (data ?? []) as any[];
    })(),
  ]);

  const closedIds = closedLeadIdSet(closedRows);
  if (closedIds.size) open = open.filter((j) => !closedIds.has(j.id));

  const bonusAvailCents = walletReads.grants
    ? bonusAvailableCents(rawBonusCents, grants)
    : rawBonusCents;
  const balanceCents =
    Number(wallet?.cash_balance_cents ?? 0) + bonusAvailCents;
  const balance = balanceCents / 100;

  const activeCount = assigned.filter(
    (l) => l.status !== "closed" && l.status !== "lost"
  ).length;
  const appliedCount = apps.length;
  const wonCount = apps.filter((a: any) => a.status === "chosen").length;
  // Same rule the board uses: a pro's first paid big-ticket lead gets the
  // intro price. Passed to the preview card so its fee matches the board's.
  const hasPaidMajor = apps.some(
    (a) => Number(a.fee_cents ?? 0) > 0 && isMajorCategory(a.category)
  );

  // The setup checklist, identical to the one on the board (both call
  // buildSetupItems). It hides itself once every step is done.
  const canUploadLogo = Boolean((contractor as any).logo_url) ? true : member;
  const setupItems = buildSetupItems({
    contractor,
    balanceCents,
    applicationCount: apps.length,
    canUploadLogo,
  });

  // The win/loss trend the Business page already computes, in one compact card
  // with a link to the detail. Members only, exactly as on /pro/business: a
  // non-member sees the Pro chip instead of a blurred number.
  const stats = member ? buildProStats(apps, new Date()) : null;

  // License / insurance renewals inside EXPIRY_WARN_DAYS. Usually empty, in
  // which case nothing renders.
  const expiring = expiryChips(contractor);

  // Feedback credit state, and the retry that makes the "grant when they later
  // qualify" case work without a cron: if the note is already on file, the
  // credit was never claimed, and this pro has since become established, grant
  // it now. Costs two indexed reads on a page that is already doing several,
  // and the SQL function is idempotent, so a double render cannot double pay.
  const feedback = await readFeedbackState(
    contractor.id,
    contractor.user_id ?? ""
  );
  const established = await isEstablishedPro(contractor.id);
  let feedbackClaimed = feedback.claimed;
  if (feedback.sent && !feedback.claimed && established) {
    feedbackClaimed = await grantFeedbackCredit(contractor.id);
  }

  // The membership nudge is for a pro with a real business who is not paying
  // us, and never for a member. The trial label needs the Pro-side
  // subscription row, which survives a cancellation, so a returning member is
  // never offered free days they will not get. Only looked up when the nudge
  // will actually render.
  const showNudge = !member && established;
  const nudgeTrialEligible = showNudge ? !(await getProSubscription()) : false;

  const firstName = (contractor as any).owner_name
    ? String((contractor as any).owner_name).trim().split(/\s+/)[0]
    : contractor.name;
  const greeting = `${greetingForHour(new Date().getHours())}, ${firstName}`;
  const subtitle = homeSubtitle({
    openJobs: open.length,
    awaitingReply,
    directRequests: directRequests.length,
  });

  return (
    <div className="space-y-6">
      {/* The board's realtime subscription and the chat drawer both belong to
          the shell rather than to the board: a new job should light the tab
          bar while the pro is sitting on Home. */}
      <LeadsRealtime contractorId={contractor.id} />
      <ChatDrawer role="contractor" />
      {/* Reaching this page means a contractors row exists, which is the only
          honest proof the signup wizard's save actually landed - so this is
          where its localStorage draft finally gets dropped. Renders nothing. */}
      <ClearOnboardingDraft userId={contractor.user_id ?? ""} />

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
          three fit across at 390px without wrapping to three lines. The Pro
          chip goes only on tiles that are actually gated: the back office is
          two free drafts then members-only, and the insights trend on
          /pro/business is members-only. The playbook is free for everyone, so
          it wears nothing. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[
          {
            href: "/pro/tools",
            icon: ClipboardList,
            title: "Write an estimate",
            shortTitle: "Estimate",
            line: "Drafts your paperwork",
            gated: true,
          },
          {
            href: "/pro/business",
            icon: TrendingUp,
            title: "Your numbers",
            shortTitle: "Numbers",
            line: "Win rate and spend",
            gated: true,
          },
          {
            href: "/pro/playbook",
            icon: BookOpen,
            title: "Playbook",
            shortTitle: "Playbook",
            line: "How to win more",
            gated: false,
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
            {!member && t.gated && (
              <p className="mt-0.5 flex flex-wrap justify-center gap-1">
                <ProChip />
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
        {directRequests.length > 0 && (
          <section className="space-y-3 sm:col-span-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                  Asked for you{" "}
                  <span className="text-stone-500 dark:text-stone-400">
                    ({directRequests.length})
                  </span>
                </h2>
                <p className="text-sm text-stone-500 dark:text-stone-400">
                  A homeowner reached out to you directly. Only you can see
                  these.
                </p>
              </div>
              {directRequests.length > DIRECT_PREVIEW && (
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
              {directRequests.slice(0, DIRECT_PREVIEW).map((d) => (
                <DirectRequestCard
                  key={d.id}
                  d={d}
                  balance={balance}
                  hasPaidMajor={hasPaidMajor}
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
                {open.length}
              </p>
            </Link>
            <Link
              href="/pro/crm"
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
          {stats ? (
            <>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {/* The same two counts /pro/business charts, summed over the
                    same six-month window, from the same buildProStats call.
                    One sentence here, the chart there. */}
                {stats.trend.reduce((n, m) => n + m.applications, 0)}{" "}
                application
                {stats.trend.reduce((n, m) => n + m.applications, 0) === 1
                  ? ""
                  : "s"}
                , {stats.trend.reduce((n, m) => n + m.wins, 0)} won.
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
                Thanks
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {feedbackCreditDollars()} in lead credit was added to your
                wallet.
              </p>
              <Link
                href="/pro/billing"
                className="inline-flex text-sm font-medium text-hearth-700 hover:underline max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
              >
                See it in your wallet
              </Link>
            </>
          ) : feedback.sent ? (
            <>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                Thanks for the feedback
              </h2>
              {/* Sent, not yet earned: say exactly what unlocks it rather than
                  leaving a promise hanging. The grant runs on its own the next
                  time this page loads after they qualify. */}
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Your {feedbackCreditDollars()} unlocks once your license is
                confirmed or you place your first lead.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                {FEEDBACK_CARD_TITLE}
              </h2>
              <p className="text-sm text-stone-600 dark:text-stone-300">
                Two questions, about a minute. We read every one.
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
                Tell us
              </Link>
            </>
          )}
        </section>

        {/* ---- Membership nudge: established non-members only ---- */}
        {showNudge && (
          <div className="sm:col-span-2">
            <ProNudge
              userId={contractor.user_id ?? ""}
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
              {latestRows.map((r: any) => (
                <li key={r.id}>
                  <Link
                    href={typeof r.url === "string" && r.url ? r.url : "/pro"}
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
