import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { isMajorCategory } from "@/lib/constants";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { variantForUser } from "@/lib/paywallExperiment";
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
import { hasCurrentInsurance } from "@/lib/insuranceGate";
import { countAwaitingReply } from "@/lib/proHomeServer";
import { buildProStats } from "@/lib/proStats";
import { readFeedbackState, grantFeedbackCredit } from "@/lib/proFeedbackServer";
// The body is one client component. That is a streaming fix, not a behaviour
// change: DBG3's SetupChecklist fix took this page from eight nested stream
// holes to one, but the page's own Flight row still deferred the entire
// two-column lower half (one deferral, measured live 2026-08-30) because the
// greeting and the tile rows above it had already spent the 3200-byte budget.
// See the long comment at the top of HomeView.tsx.
import HomeView from "./HomeView";
import { postedAgo } from "@/lib/proLeadCard";

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

  // Big-job insurance gate (0153), same read the Leads board makes: whether
  // this pro has a current certificate of insurance on file, for the
  // direct-request preview cards below.
  const insuranceCurrent = hasCurrentInsurance(
    ((contractor as any).insurance_expires as string | null) ?? null
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
  // The paywall experiment: a "hard"-variant account never leads with the
  // trial anywhere, so the nudge's CTA takes proCtaLabel's plain membership
  // branch, exactly like a pro whose trial is already spent.
  const nudgeTrialEligible = showNudge
    ? !(await getProSubscription()) &&
      variantForUser(contractor.user_id ?? null) === "soft"
    : false;

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
    <HomeView
      contractorId={contractor.id}
      userId={contractor.user_id ?? ""}
      greeting={greeting}
      subtitle={subtitle}
      expiring={expiring}
      member={member}
      // Only the preview slice crosses, with each card's clock-dependent
      // posted-ago line already resolved here: the card is a client component
      // (streaming fix, see its header comment) and that line reads the clock,
      // so it has to be settled on the server or hydration could disagree with
      // SSR.
      directRequests={directRequests.slice(0, DIRECT_PREVIEW).map((d) => ({
        id: d.id as string,
        row: d,
        postedAgoLabel: postedAgo(d.created_at),
      }))}
      directRequestCount={directRequests.length}
      showSeeAll={directRequests.length > DIRECT_PREVIEW}
      balance={balance}
      hasPaidMajor={hasPaidMajor}
      insuranceCurrent={insuranceCurrent}
      openCount={open.length}
      activeCount={activeCount}
      appliedCount={appliedCount}
      wonCount={wonCount}
      trend={
        stats
          ? {
              applications: stats.trend.reduce((n, m) => n + m.applications, 0),
              wins: stats.trend.reduce((n, m) => n + m.wins, 0),
            }
          : null
      }
      feedbackClaimed={feedbackClaimed}
      feedbackSent={feedback.sent}
      established={established}
      showNudge={showNudge}
      nudgeTrialEligible={nudgeTrialEligible}
      latestRows={latestRows.map((r: any) => ({
        id: r.id as string,
        title: r.title as string,
        href: typeof r.url === "string" && r.url ? r.url : "/pro",
      }))}
      setupItems={setupItems}
    />
  );
}
