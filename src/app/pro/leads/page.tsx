import { redirect } from "next/navigation";
// after(): run work once the response has been sent. Used below to keep the
// funnel-analytics insert off the render path.
import { after } from "next/server";
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
import { bestLeadDiscount } from "@/lib/leadPricing";
import { hasCurrentInsurance } from "@/lib/insuranceGate";
import { normalizeLeadSort } from "@/lib/leadSort";
import { trackServerEvent } from "@/lib/trackServer";
import { hasProPlan, hasActivePaidProPlan, getProSubscription } from "@/lib/subscription";
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
      // Bounded at the same 500 the pro inbox uses (src/app/pro/chats/
      // page.tsx): same table, same "newest first, nobody scrolls past that"
      // reasoning, and these rows are the wide ones - issue_description and
      // material_notes are unbounded free text, so an uncapped read is the
      // one query on this page that can grow without limit as a pro's
      // history does.
      let res = await (supabase as any)
        .from("contractor_leads")
        .select(ASSIGNED_COLUMNS_WITH_SCOPE)
        .eq("contractor_id", contractor.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (res.error && isMissingSchemaError(res.error)) {
        res = await (supabase as any)
          .from("contractor_leads")
          .select(ASSIGNED_BASE_COLUMNS)
          .eq("contractor_id", contractor.id)
          .order("created_at", { ascending: false })
          .limit(500);
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

  // Big-job insurance gate (migration 0153): does this pro have a current
  // certificate of insurance on file? Read once off the contractor row the
  // page already holds; major-tier cards below show the requirement (and
  // withhold the apply button when it is not met) so a pro learns about it
  // BEFORE typing a message or confirming a charge. The server action and
  // the SQL both re-check, so this is honesty, not the enforcement.
  const insuranceCurrent = hasCurrentInsurance(
    ((contractor as any).insurance_expires as string | null) ?? null
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
  //
  // after(), not await: this is an INSERT into app_events with the admin
  // client, and awaiting it put a whole extra Supabase round trip (measured
  // at 150-240 ms on 2026-08-30) between the last query this page needs and
  // the first byte a pro sees, purely so a counter could be written. after()
  // runs it once the response is done, so the event is still recorded exactly
  // once per render and nobody waits for it. trackServerEvent already
  // swallows its own errors, so nothing here can reject.
  after(() =>
    trackServerEvent(contractor.user_id, "lead_viewed", {
      count: open.length,
    })
  );

  // Which sort the URL asked for. The ordering itself happens in LeadsBoard
  // now (2026-08-30): the three buttons re-sort the rows the browser already
  // has instead of navigating, so a tap is instant. The board is still
  // server-rendered, so a shared /pro/leads?sort=fee link paints in that order
  // with no flash. Both sides read the same comparators from
  // src/lib/leadSort.ts, so they cannot drift apart.
  const sort = normalizeLeadSort(searchParams?.sort);

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

  // Read once per request, not once per lead: this pro's Pro membership
  // status. Used to be skipped whenever the board had jobs (only the
  // empty-state card needed it), but every open-job card's price line needs
  // it too now (the 10% member discount, migration 0149) - that "one
  // hasProPlan-style read per request" is why this moved above the view
  // models instead of living inside the openJobVms.map() below.
  const isProMember = await hasProPlan();
  // Active-only membership for the DISCOUNT specifically (migration 0151): a
  // trialing pro is a full member everywhere else, but the 10% lead discount
  // now starts only when the trial converts, so the card must show what
  // apply_to_lead will actually charge. Used only in bestLeadDiscount below.
  const proDiscountEligible = await hasActivePaidProPlan();
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
    const payoutDollars = Number(j.payout_amount ?? 0);
    // Best SINGLE discount: this pro's own Hearth Pro membership (10% off) or
    // the aging markdown, never both (migration 0149; owner's words: "it does
    // NOT stack with the 15-30%"). bestLeadDiscount is the one place this
    // comparison lives, mirrored byte-for-byte by pro_lead_fee_cents() in the
    // DB, so the price on this card is the price apply_to_lead will actually
    // charge.
    const best = bestLeadDiscount(payoutDollars, j.created_at, proDiscountEligible);
    // First big-ticket lead: the fixed intro price replaces the discounted
    // fee above when it's lower, matching what apply_to_lead will actually
    // charge (migration 0113/0149) - a fixed floor, never discounted further
    // by membership or aging.
    const introFee = introFeeFor(j.category, best.fee, hasPaidMajor);
    const fee = introFee ?? best.fee;
    const feeStr = money(fee);
    const discountKind = introFee !== null ? "intro" : best.kind;
    // The honest "Pro members pay $X" quiet line (never a silent adjustment -
    // see research-money-R3.md on marketplace trust): shown ONLY when this
    // non-member would actually pay less as a member on THIS SAME lead. A
    // member's own discount never beats aging once aging is winning (the
    // 15/30% tiers both already beat the flat 10%), and it never changes the
    // fixed intro price, so the line disappears exactly when membership would
    // not have helped - never a number that reads as a saving but isn't one.
    const memberWouldPay =
      !isProMember && introFee === null
        ? bestLeadDiscount(payoutDollars, j.created_at, true)
        : null;
    const memberQuoteStr =
      memberWouldPay && memberWouldPay.fee < best.fee
        ? money(memberWouldPay.fee)
        : null;
    const spots = Number(j.application_count ?? 0);
    const conflict = relationshipConflicts.get(j.id);
    // Homeowner's rough budget band (0047): a pricing signal, not a quote.
    // "not-sure" carries no signal, so no chip for it.
    const budgetLabel =
      j.budget_range && j.budget_range !== "not-sure"
        ? labelFor(BUDGET_RANGES, j.budget_range)
        : null;
    const timingLabel = j.timing ? labelFor(TIMING_OPTIONS, j.timing) : null;
    // Big-job insurance gate (0153): major-tier cards say so up front, and a
    // pro without current insurance gets the requirement instead of a pay
    // button that would only be refused server-side.
    const bigJob = isMajorCategory(j.category ?? "");
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
      baseStr: money(introFee !== null ? best.fee : j.payout_amount),
      off: introFee !== null ? 0 : best.off,
      introPrice: introFee !== null,
      discountKind,
      memberQuoteStr,
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
      bigJob,
      insuranceRequired: bigJob && !insuranceCurrent,
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
        insuranceCurrent={insuranceCurrent}
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
