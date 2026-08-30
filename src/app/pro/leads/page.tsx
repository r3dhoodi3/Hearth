import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import {
  labelFor,
  JOB_CATEGORIES,
  TIMING_OPTIONS,
  BUDGET_RANGES,
  MAX_APPLICANTS_PER_JOB,
  COLD_START_FREE_ALERTS,
  isMajorCategory,
} from "@/lib/constants";
import ChatDrawer from "@/components/ChatDrawer";
import LeadsRealtime from "../LeadsRealtime";
import ClearOnboardingDraft from "../ClearOnboardingDraft";
// The board itself is one client component. That is a streaming fix, not a
// behaviour change: as server markup the four card lists sat past the point
// where React Flight starts deferring elements into rows of their own, and
// this page's Flight row carried 31 deferrals on a pro with real leads. See
// the long comment at the top of LeadsBoard.tsx.
import LeadsBoard, {
  type DirectRequestItem,
  type OpenJobVM,
  type AssignedJobVM,
  type ApplicationVM,
} from "./LeadsBoard";
// The pure card helpers now live in one shared module: the "Asked for you"
// card renders on the Home tab too (a two-item preview), so it and its helpers
// had to stop being inline JSX in this file. See src/lib/proLeadCard.ts.
import {
  money,
  feeGlanceLabel,
  postedAgo,
  qualityChips,
  scopeChips,
  introFeeFor,
} from "@/lib/proLeadCard";
import { agingLeadFee } from "@/lib/leadPricing";
import { trackServerEvent } from "@/lib/trackServer";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { findActiveJobConflicts } from "@/lib/activeJobConflicts";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { getOpenJobsForMe } from "@/lib/greeting";
import {
  walletQueryPlan,
  closedLeadIdSet,
  bonusAvailableCents,
  photoUrlsByLead,
} from "@/lib/proDashboard";

export default async function ProDashboard(
  props: {
    searchParams?: Promise<{ sort?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const contractor = await getCurrentContractor();
  // No company yet: finish company setup. Whatever user_metadata.role says is
  // beside the point - anyone who reached this URL is asking for the pro side,
  // and building a company is how you get one. (A homeowner who never wanted
  // it can leave from the bare shell's sign-out or their own nav.)
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();

  const ASSIGNED_BASE_COLUMNS =
    "id, issue_id, status, category, issue_severity, issue_description, homeowner_name, homeowner_email, homeowner_phone, property_address, created_at";
  // 0114: square_footage/material_notes/has_plans_permits may not have
  // reached this DB yet - same isMissingSchemaError cascade quote-check uses
  // for a column that might predate the current migration.
  const ASSIGNED_COLUMNS_WITH_SCOPE = `${ASSIGNED_BASE_COLUMNS}, square_footage, material_notes, has_plans_permits`;

  // FIRST ROUND TRIP: everything that needs nothing but the contractor row.
  // Open jobs to apply to (safe fields only, category-matched, not yet applied),
  // the pro's own applications, the jobs they were chosen for (full detail),
  // direct requests, and the wallet.
  const [
    openJobs,
    { data: myApps },
    { data: assignedData },
    { data: directData },
    { data: wallet },
  ] = await Promise.all([
    // The same per-request cached helper the pro shell uses for the copilot's
    // opening line, so open_jobs_for_me runs once per page view instead of
    // once here and once in the layout.
    getOpenJobsForMe(),
    (supabase as any).rpc("my_applications"),
    (async () => {
      // Cast to any: the two branches select different column sets, and the
      // generated types don't narrow cleanly across a cascading reassignment
      // like this - same reasoning as the contractor_leads cascade on the
      // homeowner side (src/app/(app)/contractors/page.tsx).
      let res = await (supabase as any)
        .from("contractor_leads")
        .select(ASSIGNED_COLUMNS_WITH_SCOPE)
        .eq("contractor_id", contractor.id)
        .order("created_at", { ascending: false });
      if (res.error && isMissingSchemaError(res.error)) {
        res = await (supabase as any)
          .from("contractor_leads")
          .select(ASSIGNED_BASE_COLUMNS)
          .eq("contractor_id", contractor.id)
          .order("created_at", { ascending: false });
      }
      return res;
    })(),
    // Direct requests a homeowner aimed at this pro (0104). Masked, contact-free
    // fields plus the live-priced fee; the ONLY read path to a pending request.
    (supabase as any).rpc("my_direct_requests"),
    (supabase as any)
      .from("wallets")
      .select("id, cash_balance_cents, bonus_balance_cents")
      .eq("contractor_id", contractor.id)
      .maybeSingle(),
  ]);

  let open = openJobs as any[];
  const apps = (myApps ?? []) as any[];
  const directRequests = (directData ?? []) as any[];

  // Has this pro ever PAID for a big-ticket (major-tier) lead? Their first
  // one ever costs MAJOR_INTRO_FEE; every one after costs the normal tier
  // price. Mirrors the DB's check in migration 0113: any application row
  // with a non-zero fee on a major-category lead, refunded or not (a refund
  // pays the money back, it doesn't restore the intro). my_applications
  // already returns fee_cents + category for every application, including
  // paid direct-request unlocks, so this costs no extra query. Display-only:
  // the DB re-derives this under the wallet lock at charge time.
  const hasPaidMajor = apps.some(
    (a) => Number(a.fee_cents ?? 0) > 0 && isMajorCategory(a.category)
  );

  // Won/lost jobs sink to the bottom; active ones stay on top (newest first,
  // which the query already ordered). Array.sort is stable, so order holds.
  const isDone = (l: any) => l.status === "closed" || l.status === "lost";
  const assigned = ((assignedData ?? []) as any[]).sort(
    (a, b) => (isDone(a) ? 1 : 0) - (isDone(b) ? 1 : 0)
  );

  const openJobIds = open.map((j) => j.id);
  const assignedIssueIds = assigned
    .map((l) => l.issue_id)
    .filter((v): v is string => Boolean(v));
  const rawBonusCents = Number(wallet?.bonus_balance_cents ?? 0);
  const walletReads = walletQueryPlan(wallet, rawBonusCents);

  // SECOND ROUND TRIP: everything that needed a result from the first batch.
  // None of these four depend on each other, so they all go out together.
  // (The applications/transactions reads behind the old "Your results" card
  // moved out with it on 2026-08-30 - that card lived on Home now anyway, so
  // this page no longer pays for the query.)
  const [closedRows, relationshipConflicts, photoRows, grants] =
    await Promise.all([
      // Advisory signal only (see migration 0092's RESIDUAL note): apply_to_lead
      // has no awareness of owner_closed_at, so open_jobs_for_me - a DB function,
      // out of scope for this page - can still hand back a job the homeowner
      // already closed without picking anyone. Filtered out below, client-side,
      // rather than in the RPC body. Admin client: RLS only lets a pro SELECT a
      // lead once they're its assigned contractor ("leads contractor select",
      // 0005 migration), which an open, unassigned job never is. Best-effort and
      // fail-open: any error here (including migration 0092 not having run yet,
      // so owner_closed_at doesn't exist) returns null and leaves the board
      // unchanged rather than hiding jobs or breaking the page.
      openJobIds.length
        ? (async () => {
            const admin = createAdminClient();
            const { data, error } = await admin
              .from("contractor_leads")
              .select("id, owner_closed_at")
              .in("id", openJobIds);
            return error ? null : ((data ?? []) as any[]);
          })()
        : Promise.resolve(null),
      // Open jobs posted by a homeowner this pro already has an active job with,
      // in the same category. Those cards get "message them instead" in place of
      // the apply button: the pro already has the homeowner in Messages, so a
      // second apply fee would double-charge them for the same relationship.
      // Once the earlier job closes, the job becomes applyable again. Asked with
      // the pre-filter id list so it can run alongside the closed-job sweep: a
      // job dropped by that sweep is simply never looked up in the map.
      findActiveJobConflicts(contractor.id, openJobIds),
      // Full-resolution job photos for the leads this pro was chosen for. The
      // photos table is owner-only under RLS, so we read the urls via the admin
      // client (best-effort: any error just leaves those cards photo-less). The
      // /api/job-photo route re-checks entitlement with can_view_job_photo_full
      // before it signs anything, so this lookup is display data, not the gate.
      assignedIssueIds.length
        ? (async () => {
            const admin = createAdminClient();
            const { data } = await admin
              .from("photos")
              .select("related_id, url, uploaded_at")
              .eq("related_type", "issue")
              .in("related_id", assignedIssueIds)
              .order("uploaded_at", { ascending: true });
            return (data ?? []) as any[];
          })()
        : Promise.resolve([] as any[]),
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
    ]);

  const closedIds = closedLeadIdSet(closedRows);
  if (closedIds.size) {
    open = open.filter((j) => !closedIds.has(j.id));
  }

  // Funnel analytics (docs/ANALYTICS.md), once per render of the board -
  // same "fires on render" convention as paywall_seen. Count only, never the
  // job ids or any detail from them.
  await trackServerEvent(contractor.user_id, "lead_viewed", {
    count: open.length,
  });

  // Sort the open-jobs board. The effective fee (after the aging markdown) is
  // what "cheapest" means to a pro, and "deal" surfaces the biggest markdowns.
  const sort =
    searchParams?.sort === "fee" || searchParams?.sort === "deal"
      ? searchParams.sort
      : "new";
  const effFee = (j: any) =>
    agingLeadFee(Number(j.payout_amount ?? 0), j.created_at);
  if (sort === "fee") open.sort((a, b) => effFee(a).fee - effFee(b).fee);
  else if (sort === "deal")
    open.sort(
      (a, b) => effFee(b).off - effFee(a).off || effFee(a).fee - effFee(b).fee
    );

  const assignedPhotos = photoUrlsByLead(assigned, photoRows);

  // Applications still waiting on the homeowner (not yet chosen for the job).
  const pendingApps = apps.filter((a) => a.status === "applied");
  const declinedApps = apps.filter((a) => a.status === "declined");

  // Spendable bonus is what apply_to_lead (migration 0058) actually honors:
  // only bonus backed by live, unexpired grants. The raw wallet counter can
  // overstate that for up to a day, because an expired grant lingers in the
  // counter until the daily expire-bonus sweep reconciles it. Cap at the live
  // grant sum so canAfford and the ?need= deposit amount below match what the
  // apply RPC will accept, instead of offering an Apply that gets refused or
  // under-asking on the add-funds prompt.
  const bonusAvailCents = walletReads.grants
    ? bonusAvailableCents(rawBonusCents, grants)
    : rawBonusCents;
  const balanceCents =
    Number(wallet?.cash_balance_cents ?? 0) + bonusAvailCents;
  const balance = balanceCents / 100;
  const lowBalance = balanceCents < 5000;

  // Only the empty-state card needs membership status (to hide the Pro-alerts
  // suggestion from members), so skip the lookup when the board has jobs. This
  // one stays sequential on purpose: it depends on the board AFTER the
  // closed-job filter above, and on the common path (jobs on the board) it
  // never runs at all.
  const isProMember = open.length === 0 ? await hasProPlan() : false;
  // Whether that same suggestion may lead with the free trial. Guarded exactly
  // like isProMember, plus the flag: while COLD_START_FREE_ALERTS is on the
  // upsell never renders, so the lookup never runs. Only a pro with no
  // pro-side subscriptions row gets a trial (the row survives a cancellation),
  // which is the same signal /pro/crm uses.
  const proTrialEligible =
    open.length === 0 && !COLD_START_FREE_ALERTS && !isProMember
      ? !(await getProSubscription())
      : false;

  // ---- View models -------------------------------------------------------
  // Everything the board renders, resolved HERE rather than in the markup, so
  // LeadsBoard takes plain data and this page's Flight row has no elements
  // left to defer. See the long comment at the top of LeadsBoard.tsx.
  //
  // This is also the only correct place for it: the aging fee, the intro
  // price and the posted-ago line all read the clock, and a client component
  // that recomputed them during hydration could disagree with what SSR
  // printed. They are finished strings by the time they cross the boundary.

  // Asked for you. The card still takes the RPC row itself (plain JSON), plus
  // the one clock-dependent label lifted out of it.
  const directItems: DirectRequestItem[] = directRequests.map((d) => ({
    id: d.id,
    row: d,
    postedAgoLabel: postedAgo(d.created_at),
  }));

  const openJobVms: OpenJobVM[] = open.map((j) => {
    const aged = agingLeadFee(Number(j.payout_amount ?? 0), j.created_at);
    // First big-ticket lead: the intro price replaces the normal (possibly
    // aging-discounted) fee when it's lower, matching what apply_to_lead will
    // actually charge (migration 0113).
    const introFee = introFeeFor(j.category, aged.fee, hasPaidMajor);
    const fee = introFee ?? aged.fee;
    const feeStr = money(fee);
    const spots = Number(j.application_count ?? 0);
    const conflict = relationshipConflicts.get(j.id);
    // Homeowner's rough budget band (0047): a pricing signal, not a quote.
    // "not-sure" carries no signal, so no chip for it.
    const budgetLabel =
      j.budget_range && j.budget_range !== "not-sure"
        ? labelFor(BUDGET_RANGES, j.budget_range)
        : null;
    const timingLabel = j.timing ? labelFor(TIMING_OPTIONS, j.timing) : null;
    return {
      id: j.id,
      categoryLabel: labelFor(JOB_CATEGORIES, j.category),
      city: j.city ?? null,
      severity: j.issue_severity ?? null,
      ownershipVerified: Boolean(j.ownership_verified),
      feeGlance: feeGlanceLabel(fee, feeStr),
      glanceLine2: [timingLabel, j.city ? `in ${j.city}` : null]
        .filter(Boolean)
        .join(" · "),
      feeStr,
      baseStr: money(introFee !== null ? aged.fee : j.payout_amount),
      off: aged.off,
      introPrice: introFee !== null,
      description: j.issue_description ?? null,
      photoUrls: Array.isArray(j.photo_urls) ? (j.photo_urls as string[]) : [],
      budgetLabel,
      chips: qualityChips(j),
      scope: scopeChips(j),
      hasPlansPermits: j.has_plans_permits === true,
      postedAgoLabel: postedAgo(j.created_at),
      timingLabel,
      spots,
      full: spots >= MAX_APPLICANTS_PER_JOB,
      conflict: conflict
        ? {
            categoryLabel: labelFor(JOB_CATEGORIES, conflict.category),
            activeLeadId: conflict.activeLeadId,
            homeownerName: conflict.homeownerName || "Homeowner",
          }
        : null,
      feeCents: Math.round(fee * 100),
      canAfford: balance >= fee,
      billingHref: `/pro/billing?need=${Math.max(0, fee - balance).toFixed(
        2
      )}&category=${encodeURIComponent(j.category ?? "")}`,
    };
  });

  const assignedJobs: AssignedJobVM[] = assigned.map((l) => ({
    id: l.id,
    categoryLabel: labelFor(JOB_CATEGORIES, l.category),
    severity: l.issue_severity ?? null,
    status: l.status,
    description: l.issue_description ?? null,
    scope: scopeChips(l),
    hasPlansPermits: l.has_plans_permits === true,
    photoUrls: assignedPhotos.get(l.id) ?? [],
    homeownerName: l.homeowner_name || "-",
    chatName: l.homeowner_name || "Homeowner",
    propertyAddress: l.property_address || "-",
    contactLine: `${l.homeowner_email || "-"}${
      l.homeowner_phone ? ` · ${l.homeowner_phone}` : ""
    }`,
  }));

  const appVm = (a: any): ApplicationVM => ({
    applicationId: a.application_id,
    categoryLabel: labelFor(JOB_CATEGORIES, a.category),
    description: a.issue_description ?? null,
    refunded: Boolean(a.refunded_at),
  });

  return (
    <div className="space-y-8">
      <LeadsRealtime contractorId={contractor.id} />
      <ChatDrawer role="contractor" />

      {/* The one true page heading. The Leads tab IS the board now (2026-08-30):
          the setup checklist, the "Your results" text wall, the active-jobs /
          wallet stat cards, and the "Clients" button all moved to Home (or, for
          Clients, its own tab) so a pro does not scroll past a second copy of
          the same chrome to reach an open job. What is left below is the board
          itself: the low-funds line when it applies, Asked for you, Open jobs,
          Your jobs, and Applications. */}
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Your leads</h1>

      {/* Reaching this page means a contractors row exists, which is the only
          honest proof the signup wizard's save actually landed - so this is
          where its localStorage draft finally gets dropped. The wizard itself
          deliberately keeps the draft through a submit, because a refused save
          sends the pro straight back to that form (see the draft-lifetime
          comment in pro/onboarding/OnboardingCompanyForm.tsx). Renders
          nothing. */}
      <ClearOnboardingDraft userId={contractor.user_id ?? ""} />

      {/* A phone-only copilot row used to sit here. The copilot has one home
          now, the Messages tab: the pinned row at the top of /pro/chats, same
          rule as the homeowner side. */}

      {/* Every section of the board lives in LeadsBoard, a client component,
          purely so this page's Flight row ends with one client reference
          carrying plain data instead of a long tail of card elements. Nothing
          below this point is newly interactive. See LeadsBoard.tsx. */}
      <LeadsBoard
        lowBalance={lowBalance}
        directRequests={directItems}
        balance={balance}
        hasPaidMajor={hasPaidMajor}
        openJobs={openJobVms}
        sort={sort}
        hasApplied={apps.length > 0}
        isProMember={isProMember}
        proTrialEligible={proTrialEligible}
        assigned={assignedJobs}
        pendingApps={pendingApps.map(appVm)}
        declinedApps={declinedApps.map(appVm)}
      />
    </div>
  );
}
