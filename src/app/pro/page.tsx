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
  MAJOR_INTRO_FEE,
  LEAD_TIER_FEES,
  isMajorCategory,
} from "@/lib/constants";
import { Check } from "lucide-react";
import Link from "next/link";
import OpenChatButton from "@/components/OpenChatButton";
import ChatDrawer from "@/components/ChatDrawer";
import LeadsRealtime from "./LeadsRealtime";
import ApplyJobButton from "./ApplyJobButton";
import DirectRequestActions from "./DirectRequestActions";
import JobStatusSelect from "./JobStatusSelect";
import JobPhotoStrip from "./JobPhotoStrip";
import SetupChecklist, { type SetupItem } from "@/components/pro/SetupChecklist";
import ClearOnboardingDraft from "./ClearOnboardingDraft";
import { agingLeadFee } from "@/lib/leadPricing";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { proCtaLabel, proTrialSubline } from "@/components/pro/ProUpgradeCta";
import { findActiveJobConflicts } from "@/lib/activeJobConflicts";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { getOpenJobsForMe } from "@/lib/greeting";
import {
  walletQueryPlan,
  closedLeadIdSet,
  bonusAvailableCents,
  photoUrlsByLead,
  totalSpentCents,
} from "@/lib/proDashboard";

const SEVERITY_STYLE: Record<string, string> = {
  low: "border-stone-200 bg-stone-50 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300",
  medium: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  urgent: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300",
};

const STATUS_STYLE: Record<string, string> = {
  new: "border-hearth-200 bg-hearth-50 text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300",
  accepted: "border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300",
  // Done-and-dusted reads muted so it can't be confused with the active green.
  closed: "border-stone-200 bg-stone-100 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300",
  lost: "border-stone-200 bg-stone-100 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400",
};

// Friendly labels for the pipeline statuses a pro sets on their own jobs.
const STATUS_LABEL: Record<string, string> = {
  new: "New lead",
  accepted: "Active",
  closed: "Won",
  lost: "Lost",
};

function money(n: number | string | null) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "-";
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

// The fee slot on a phone lead card's one-line glance. Normally the already-
// formatted price string; "Free" for an exact-zero fee, "New lead" as a
// defensive fallback if a fee could not be computed at all - LEAD_TIER_FEES
// never actually reaches zero today, but the glance line should never show a
// blank price.
function feeGlanceLabel(fee: number, feeStr: string): string {
  if (!Number.isFinite(fee)) return "New lead";
  if (fee <= 0) return "Free";
  return feeStr;
}

// How long a job has been sitting open - shown on the card so a pro can see
// why an aging markdown exists (or that a listing is brand new).
function postedAgo(createdAt: string | null | undefined): string | null {
  const t = new Date(createdAt ?? "").getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "Posted today";
  return `Posted ${days} day${days === 1 ? "" : "s"} ago`;
}

// Tiny factual signals a pro can price-judge a posting with. No scores, just
// whether the homeowner gave pros something real to go on. Freshness already
// shows via the posted-ago line, so it isn't repeated here.
function qualityChips(j: any): string[] {
  const chips: string[] = [];
  // Major-tier jobs (roof/structural/remodeling) need real detail to bid
  // seriously - 80 characters of filler doesn't cut it at that price point,
  // so the floor doubles for those categories only (0114). Every other
  // category keeps the original 80.
  const detailFloor = isMajorCategory(j.category) ? 160 : 80;
  if ((j.issue_description ?? "").trim().length >= detailFloor)
    chips.push("Detailed description");
  // Photos are now shown as a thumbnail strip on the card, so no redundant
  // "Photos attached" chip; a job with photos but no rendered urls (rare) still
  // gets no chip - the strip is the signal now.
  if (j.timing) chips.push("Timing set");
  return chips;
}

// Major-tier project scope (0114): square footage and material notes, shown
// as the same muted chip tokens as budget/quality above. Only meaningful for
// roof/structural/remodeling jobs, and only when the homeowner actually filled
// them in - undefined until migration 0114 reaches the DB, which reads the
// same as "not provided" here.
function scopeChips(j: any): string[] {
  const chips: string[] = [];
  if (!isMajorCategory(j.category)) return chips;
  const sqFt = Number(j.square_footage);
  if (Number.isFinite(sqFt) && sqFt > 0) {
    chips.push(`${sqFt.toLocaleString()} sq ft`);
  }
  const materials = typeof j.material_notes === "string" ? j.material_notes.trim() : "";
  if (materials) chips.push(materials);
  return chips;
}

// Leads-board sort options. Newest is the default (and the order the RPC
// already returns); the others are cheap client-side re-sorts.
const SORT_OPTIONS = [
  { value: "new", label: "Newest" },
  { value: "fee", label: "Cheapest fee" },
  { value: "deal", label: "Biggest deal" },
] as const;

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
  // The intro only undercuts the shown fee when it is actually lower (the DB
  // charges least(aged fee, intro), so an aging markdown below $49.99 wins).
  const introFeeFor = (category: string, normalFee: number) =>
    !hasPaidMajor && isMajorCategory(category) && MAJOR_INTRO_FEE < normalFee
      ? MAJOR_INTRO_FEE
      : null;

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
  // None of these six depend on each other, so they all go out together.
  const [closedRows, relationshipConflicts, photoRows, grants, appRows, txnRows] =
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
      // "Your results" card: how the pro's applications have paid off so far.
      walletReads.applications
        ? (async () => {
            const { data } = await (supabase as any)
              .from("lead_applications")
              .select("status")
              .eq("contractor_id", contractor.id);
            return (data ?? []) as any[];
          })()
        : Promise.resolve([] as any[]),
      walletReads.transactions
        ? (async () => {
            const { data } = await (supabase as any)
              .from("wallet_transactions")
              .select("type, cash_delta_cents, bonus_delta_cents")
              .eq("wallet_id", wallet.id);
            return (data ?? []) as any[];
          })()
        : Promise.resolve([] as any[]),
    ]);

  const closedIds = closedLeadIdSet(closedRows);
  if (closedIds.size) {
    open = open.filter((j) => !closedIds.has(j.id));
  }

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

  const activeCount = assigned.filter(
    (l) => l.status !== "closed" && l.status !== "lost"
  ).length;

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

  // The logo is a Pro-member cosmetic (savePublicPageAction re-checks
  // membership server-side), so for a non-member the checklist's "Upload your
  // logo" step is a door that does not open. Only worth a membership lookup
  // when the logo is actually missing; hasProPlan reads the per-request cached
  // subscription row, so this shares one query with the later call below.
  const logoDone = Boolean((contractor as any).logo_url);
  const canUploadLogo = logoDone ? true : await hasProPlan();

  // License state, as the checklist below reads it: a number alone is not the
  // finish line, the CSLB saying yes is (license_verified_status, 0037/0055).
  const licenseStatus = contractor.license_verified_status ?? "unverified";
  const licenseFailed =
    Boolean(contractor.license_number) && licenseStatus === "failed";
  // A number on file that is neither confirmed nor refused is waiting on a
  // check this pro cannot hurry along, so it stays visible and unticked but
  // does not hold the whole card open forever (same reasoning as `optional`
  // on the members-only logo step).
  const licenseAwaitingCheck =
    Boolean(contractor.license_number) &&
    licenseStatus !== "verified" &&
    licenseStatus !== "failed";

  // First-session setup checklist. Every item comes from data this page
  // already loads (the contractor row, the wallet, my_applications), so it
  // costs nothing extra and hides itself once every step is done.
  const setupItems: SetupItem[] = [
    {
      label: "Complete your company profile",
      done: Boolean(contractor.name) && (contractor.categories ?? []).length > 0,
      href: "/pro/profile",
      linkLabel: "Complete profile",
    },
    // Only a CSLB-verified license counts as done. A number that the CSLB
    // refused used to tick this box, which told a pro their license was
    // handled while /pro/profile showed "Not confirmed" on the same row - and
    // left the one step they had to act on looking finished.
    {
      label: licenseFailed
        ? "License not confirmed"
        : "Put your license on file",
      done: licenseStatus === "verified",
      href: "/pro/profile",
      linkLabel: licenseFailed ? "Fix license" : "Add license",
      optional: licenseAwaitingCheck,
    },
    // Plain outbound links only (0110). Done as soon as either is on file;
    // no reason to require both. Pros with review links get more quotes
    // accepted, so this comes right after license, ahead of the members-only
    // logo step.
    {
      label:
        "Add your Yelp or Google reviews link",
      hint: "Pros with review links get more quotes accepted.",
      done:
        Boolean(contractor.yelp_url) || Boolean(contractor.google_reviews_url),
      href: "/pro/profile#reviews",
      linkLabel: "Add reviews link",
    },
    // Marked optional for non-members so the card can still reach its
    // done-state (and disappear) without it: nagging someone forever about a
    // step their account cannot complete is worse than not listing it.
    {
      label: canUploadLogo ? "Upload your logo" : "Upload your logo (Pro)",
      done: logoDone,
      href: canUploadLogo ? "/pro/profile" : "/pro/plus",
      linkLabel: canUploadLogo ? "Add logo" : "See Hearth Pro",
      optional: !canUploadLogo,
    },
    {
      label: "Fund your wallet",
      done: balanceCents > 0,
      href: "/pro/billing",
      linkLabel: "Add funds",
    },
    {
      label: "Apply to your first job",
      done: apps.length > 0,
      href: "#open-jobs",
      linkLabel: "Browse jobs",
    },
  ];

  // "Your results" card: how the pro's applications have paid off so far.
  const appliedCount = appRows.length;
  const wonCount = appRows.filter((a: any) => a.status === "chosen").length;

  const spent = totalSpentCents(txnRows) / 100;

  // Only the empty-state card needs membership status (to hide the Pro-alerts
  // suggestion from members), so skip the lookup when the board has jobs. This
  // one stays sequential on purpose: it depends on the board AFTER the
  // closed-job filter above, and on the common path (jobs on the board) it
  // never runs at all. When the setup checklist above already asked (a pro
  // with no logo on file), hasProPlan reads the same request-cached
  // subscription rows, so this costs nothing extra either.
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

  return (
    <div className="space-y-8">
      <LeadsRealtime contractorId={contractor.id} />
      <ChatDrawer role="contractor" />

      {/* The one true page heading; the sections below step down to h2. */}
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Your leads</h1>

      {/* Reaching this page means a contractors row exists, which is the only
          honest proof the signup wizard's save actually landed - so this is
          where its localStorage draft finally gets dropped. The wizard itself
          deliberately keeps the draft through a submit, because a refused save
          sends the pro straight back to that form (see the draft-lifetime
          comment in pro/onboarding/OnboardingCompanyForm.tsx). Renders
          nothing. */}
      <ClearOnboardingDraft userId={contractor.user_id ?? ""} />

      <SetupChecklist items={setupItems} />

      {lowBalance && (
        <div className="card flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/15">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            You&apos;re low on funds. Add funds to keep applying, and deposits of
            $200+ earn bonus credit.
          </p>
          <Link href="/pro/billing" className="btn-primary shrink-0">
            Add funds
          </Link>
        </div>
      )}

      {/* Hero treatment only once there are results to celebrate; before the
          first application this is just a quiet pointer. */}
      <section
        className={`space-y-1 ${appliedCount === 0 ? "card" : "card-hero"}`}
      >
        <p className="stat-label">Your results</p>
        {appliedCount === 0 ? (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              You haven&apos;t applied to a job yet. Apply to an open job below to
              start winning work.
            </p>
            {apps.length === 0 && (
              // The canonical guarantee sentence: the 60 days mirrors the
              // bonus-grant expiry in migration 0041.
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {contractor.license_number
                  ? "Not chosen on your first application? The fee comes back on its own as wallet credit, spendable on any lead, and it expires after 60 days. It's credit toward future leads, not cash back to your card."
                  : "Adding your license unlocks the first-application guarantee. Not chosen on your first application? The fee comes back on its own as wallet credit, spendable on any lead, and it expires after 60 days. It's credit toward future leads, not cash back to your card."}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              You&apos;ve won {wonCount} job{wonCount === 1 ? "" : "s"} from{" "}
              {appliedCount} application{appliedCount === 1 ? "" : "s"}.
            </p>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Total spent on applications:{" "}
              <span className="[font-variant-numeric:tabular-nums]">
                ${spent.toFixed(2)}
              </span>
              .
              {appliedCount >= 3 &&
                ` Win rate: ${Math.round((wonCount / appliedCount) * 100)}%.`}
            </p>
          </>
        )}
      </section>

      {/* Two stats only: the Open jobs section right below already shows its
          own count, so a third card would just repeat it. */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="card">
          <p className="stat-label">Active jobs</p>
          <p className="stat-number mt-1 text-4xl text-stone-900 dark:text-stone-100">
            {activeCount}
          </p>
        </div>
        <Link
          href="/pro/billing"
          className="card-link hover:border-hearth-400 dark:hover:border-hearth-400"
        >
          <p className="stat-label">Wallet balance</p>
          <p className="stat-number mt-1 text-4xl text-stone-900 dark:text-stone-100">
            ${balance.toFixed(2)}
          </p>
          <p className="mt-1 text-xs font-medium text-hearth-700 dark:text-hearth-300">Add funds →</p>
        </Link>
      </section>

      {/* ---- Asked for you: a homeowner reached out to this pro directly ----
          Sits above the open board because it is exclusive: only this pro can
          see or unlock it. Card anatomy mirrors an open-job card (same classes,
          same photo preview), minus the applicant count and aging deal - a
          direct request has no competition and no markdown. */}
      {directRequests.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              Asked for you{" "}
              <span className="text-stone-500 dark:text-stone-400">
                ({directRequests.length})
              </span>
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              A homeowner reached out to you directly. Unlock to accept, see their
              contact, and open the chat. Only you can see these.
            </p>
          </div>
          <ul className="space-y-3">
            {directRequests.map((d) => {
              const normalFee = Number(d.fee_cents ?? 0) / 100;
              const introFee = introFeeFor(d.category, normalFee);
              const fee = introFee ?? normalFee;
              const feeStr = money(fee);
              const chips = qualityChips(d);
              const scope = scopeChips(d);
              const budgetLabel =
                d.budget_range && d.budget_range !== "not-sure"
                  ? labelFor(BUDGET_RANGES, d.budget_range)
                  : null;
              const feeGlance = feeGlanceLabel(fee, feeStr);
              const glanceLine2 = [
                d.timing ? labelFor(TIMING_OPTIONS, d.timing) : null,
                d.city ? `in ${d.city}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              // Folded detail (0128 phone density pass): description, photos,
              // budget/quality/scope chips, posted-ago/timing. Rendered once
              // here and reused below in both the phone <details> and the
              // desktop always-visible div, so the two variants can never
              // drift out of sync.
              const detailsContent = (
                <>
                  {d.issue_description ? (
                    <p className="text-sm text-stone-600 dark:text-stone-400">
                      {d.issue_description}
                    </p>
                  ) : (
                    <p className="text-sm italic text-stone-500 dark:text-stone-400">
                      No details provided yet
                    </p>
                  )}
                  {Array.isArray(d.photo_urls) && d.photo_urls.length > 0 && (
                    <JobPhotoStrip leadId={d.id} urls={d.photo_urls} />
                  )}
                  {(chips.length > 0 || budgetLabel) && (
                    <div className="flex flex-wrap gap-1">
                      {budgetLabel && (
                        <span className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400">
                          Budget: {budgetLabel}
                        </span>
                      )}
                      {chips.map((c) => (
                        <span
                          key={c}
                          className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Major-tier project scope (0114): sq ft / materials as the
                      same muted chip, plans/permits as a positive chip-ok. */}
                  {(scope.length > 0 || d.has_plans_permits === true) && (
                    <div className="flex flex-wrap gap-1">
                      {scope.map((c) => (
                        <span
                          key={c}
                          className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                        >
                          {c}
                        </span>
                      ))}
                      {d.has_plans_permits === true && (
                        <span className="chip-ok">Plans/permits in hand</span>
                      )}
                    </div>
                  )}
                  {(postedAgo(d.created_at) || d.timing) && (
                    <div className="flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
                      {postedAgo(d.created_at) && (
                        <span className="text-xs text-stone-500 dark:text-stone-400">
                          {postedAgo(d.created_at)}
                        </span>
                      )}
                      {d.timing && (
                        <span>Timing: {labelFor(TIMING_OPTIONS, d.timing)}</span>
                      )}
                    </div>
                  )}
                </>
              );
              return (
                <li key={d.id} className="card space-y-3">
                  {/* Header: one glanceable line below sm (category + fee,
                      then timing/city), the full desktop row at sm+. Both
                      variants share one wrapper div so this list item's
                      space-y-3 sees a single child here rather than two -
                      Tailwind's space-y margin selector only excludes
                      children carrying the HTML "hidden" attribute, not ones
                      merely styled display:none, so two breakpoint-gated
                      siblings would each still count and add a phantom gap.
                      Same reasoning applies to the folded-detail wrapper
                      below. */}
                  <div>
                    <div className="sm:hidden">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(JOB_CATEGORIES, d.category)}
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-stone-700 [font-variant-numeric:tabular-nums] dark:text-stone-300">
                          {feeGlance}
                        </span>
                      </div>
                      {glanceLine2 && (
                        <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                          {glanceLine2}
                        </p>
                      )}
                    </div>
                    <div className="hidden flex-wrap items-center gap-2 sm:flex">
                      <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                        {labelFor(JOB_CATEGORIES, d.category)}
                        {d.city ? (
                          <span className="font-normal text-stone-500 dark:text-stone-400">
                            in {d.city}
                          </span>
                        ) : null}
                      </span>
                      <span className="chip border border-hearth-200 bg-hearth-50 text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                        Direct request
                      </span>
                      {d.issue_severity && (
                        <span
                          className={`chip border ${SEVERITY_STYLE[d.issue_severity] ?? ""}`}
                        >
                          {d.issue_severity}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-300">
                        {introFee !== null && (
                          <span className="chip border border-hearth-200 bg-hearth-50 font-semibold text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                            First big-ticket lead
                          </span>
                        )}
                        <span className="[font-variant-numeric:tabular-nums]">
                          Unlock fee{" "}
                          {introFee !== null && (
                            <span className="text-stone-500 line-through dark:text-stone-400">
                              {money(normalFee)}
                            </span>
                          )}{" "}
                          {feeStr}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Folded detail: description, photos, budget/quality/scope
                      chips, and posted-ago/timing - collapsed by default on
                      phone via a real <details> disclosure, always visible
                      above sm. */}
                  <div>
                    <details className="group sm:hidden">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-medium text-hearth-700 [&::-webkit-details-marker]:hidden dark:text-hearth-300">
                        Details
                        <svg
                          viewBox="0 0 20 20"
                          className="h-4 w-4 transition-transform group-open:rotate-180"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path
                            fillRule="evenodd"
                            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </summary>
                      <div className="mt-2 space-y-3">{detailsContent}</div>
                    </details>
                    <div className="hidden space-y-3 sm:block">{detailsContent}</div>
                  </div>

                  <DirectRequestActions
                    leadId={d.id}
                    fee={feeStr}
                    feeCents={Math.round(fee * 100)}
                    canAfford={balance >= fee}
                    billingHref={`/pro/billing?need=${Math.max(
                      0,
                      fee - balance
                    ).toFixed(2)}&category=${encodeURIComponent(
                      d.category ?? ""
                    )}`}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ---- Open jobs: posted by homeowners, pay the fee to apply ---- */}
      <section id="open-jobs" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              Open jobs <span className="text-stone-500 dark:text-stone-400">({open.length})</span>
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Jobs homeowners posted in your categories. Apply to one and the
              homeowner reviews you. If they pick you, you get their contact.
            </p>
            {/* The price of applying belonged on the board itself, not only on
                Billing: a pro should never have to leave the inbox to find out
                what a tap costs. Both numbers come from LEAD_TIER_FEES, the
                one place the tiers live, so this line cannot drift from the
                per-card fee shown below. */}
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Applying costs ${LEAD_TIER_FEES.light} to ${LEAD_TIER_FEES.major}{" "}
              per lead depending on the trade, returned as wallet credit if the
              homeowner picks someone else.{" "}
              <Link
                href="/pro/billing"
                className="underline hover:text-stone-600 dark:hover:text-stone-300"
              >
                Details on Billing
              </Link>
              .
            </p>
          </div>
          {open.length > 1 && (
            <div className="flex gap-2">
              {SORT_OPTIONS.map((o) => (
                <Link
                  key={o.value}
                  href={o.value === "new" ? "/pro" : `/pro?sort=${o.value}`}
                  className={`inline-flex min-h-[44px] items-center rounded-full border px-3 py-1.5 text-xs sm:inline-block sm:min-h-0 ${
                    sort === o.value
                      ? "border-hearth-300 bg-hearth-50 font-medium text-hearth-700 dark:border-hearth-500/40 dark:bg-hearth-500/15 dark:text-hearth-300"
                      : "border-stone-200 text-stone-500 hover:border-stone-300 dark:border-white/10 dark:text-stone-400 dark:hover:border-stone-600"
                  }`}
                >
                  {o.label}
                </Link>
              ))}
            </div>
          )}
        </div>

        {open.length === 0 ? (
          // Honest empty state: no fake urgency, no invented stats. Just the
          // truth about a young marketplace and three useful things to do
          // while waiting (each conditional line only shows when it applies).
          <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center dark:border-stone-700">
            <p className="font-medium text-stone-900 dark:text-stone-100">
              No open jobs in your trades right now.
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Hearth is growing; new jobs land here the moment homeowners post
              them.
            </p>
            <ul className="mx-auto mt-4 max-w-md space-y-2 text-left text-sm">
              <li className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-hearth-600" aria-hidden="true" />
                <span>
                  Make your page worth picking:{" "}
                  <Link
                    href="/pro/profile"
                    className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
                  >
                    complete your public page
                  </Link>{" "}
                  (categories, license, logo) so you stand out when jobs
                  arrive.
                </span>
              </li>
              {apps.length === 0 && (
                <li className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-hearth-600" aria-hidden="true" />
                  <span>
                    Not chosen on your first application? The fee comes back
                    on its own as wallet credit, spendable on any lead, and it
                    expires after 60 days.{" "}
                    <Link
                      href="/pro/billing"
                      className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
                    >
                      Fund your wallet
                    </Link>{" "}
                    so you can apply the moment something posts.
                  </span>
                </li>
              )}
              {/* COLD START: while COLD_START_FREE_ALERTS is on, every pro
                  gets instant alerts, so the honest line is a plain statement.
                  The membership upsell version returns when the flag flips. */}
              {COLD_START_FREE_ALERTS ? (
                <li className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-hearth-600" aria-hidden="true" />
                  <span>
                    You&apos;ll be alerted the moment a job posts in your
                    trades, so you never check an empty board.
                  </span>
                </li>
              ) : (
                !isProMember && (
                  <li className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-hearth-600" aria-hidden="true" />
                    <span>
                      <Link
                        href="/pro/plus"
                        className="font-medium text-hearth-700 hover:underline dark:text-hearth-300"
                      >
                        {proTrialEligible
                          ? proCtaLabel(true)
                          : "Get alerts the moment a job posts"}
                      </Link>{" "}
                      {proTrialEligible
                        ? `and get alerts the moment a job posts, so you never check an empty board. ${proTrialSubline()}`
                        : "with a Pro membership, so you never check an empty board."}
                    </span>
                  </li>
                )
              )}
            </ul>
          </div>
        ) : (
          <ul className="space-y-3">
            {open.map((j) => {
              const aged = agingLeadFee(
                Number(j.payout_amount ?? 0),
                j.created_at
              );
              const off = aged.off;
              // First big-ticket lead: the intro price replaces the normal
              // (possibly aging-discounted) fee when it's lower, matching
              // what apply_to_lead will actually charge (migration 0113).
              const introFee = introFeeFor(j.category, aged.fee);
              const fee = introFee ?? aged.fee;
              const feeStr = money(fee);
              const baseStr = money(introFee !== null ? aged.fee : j.payout_amount);
              const spots = Number(j.application_count ?? 0);
              const full = spots >= MAX_APPLICANTS_PER_JOB;
              const conflict = relationshipConflicts.get(j.id);
              const chips = qualityChips(j);
              const scope = scopeChips(j);
              // Homeowner's rough budget band (0047): a pricing signal, not a
              // quote. "not-sure" carries no signal, so no chip for it.
              const budgetLabel =
                j.budget_range && j.budget_range !== "not-sure"
                  ? labelFor(BUDGET_RANGES, j.budget_range)
                  : null;
              const feeGlance = feeGlanceLabel(fee, feeStr);
              const glanceLine2 = [
                j.timing ? labelFor(TIMING_OPTIONS, j.timing) : null,
                j.city ? `in ${j.city}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              // Folded detail (0128 phone density pass): description, photos,
              // budget/quality/scope chips, posted-ago/timing. Rendered once
              // here and reused below in both the phone <details> and the
              // desktop always-visible div, so the two variants can never
              // drift out of sync.
              const detailsContent = (
                <>
                  {j.issue_description ? (
                    <p className="text-sm text-stone-600 dark:text-stone-400">
                      {j.issue_description}
                    </p>
                  ) : (
                    <p className="text-sm italic text-stone-500 dark:text-stone-400">
                      No details provided yet
                    </p>
                  )}
                  {Array.isArray(j.photo_urls) && j.photo_urls.length > 0 && (
                    <JobPhotoStrip leadId={j.id} urls={j.photo_urls} />
                  )}
                  {(chips.length > 0 || budgetLabel) && (
                    <div className="flex flex-wrap gap-1">
                      {budgetLabel && (
                        <span className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400">
                          Budget: {budgetLabel}
                        </span>
                      )}
                      {chips.map((c) => (
                        <span
                          key={c}
                          className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Major-tier project scope (0114): sq ft / materials as the
                      same muted chip, plans/permits as a positive chip-ok. */}
                  {(scope.length > 0 || j.has_plans_permits === true) && (
                    <div className="flex flex-wrap gap-1">
                      {scope.map((c) => (
                        <span
                          key={c}
                          className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                        >
                          {c}
                        </span>
                      ))}
                      {j.has_plans_permits === true && (
                        <span className="chip-ok">Plans/permits in hand</span>
                      )}
                    </div>
                  )}
                  {(postedAgo(j.created_at) || j.timing) && (
                    <div className="flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
                      {postedAgo(j.created_at) && (
                        <span className="text-xs text-stone-500 dark:text-stone-400">
                          {postedAgo(j.created_at)}
                        </span>
                      )}
                      {j.timing && (
                        <span>
                          Timing: {labelFor(TIMING_OPTIONS, j.timing)}
                        </span>
                      )}
                    </div>
                  )}
                </>
              );
              return (
                <li key={j.id} className="card space-y-3">
                  {/* Header: one glanceable line below sm (category + fee,
                      then timing/city), the full desktop row at sm+. Both
                      variants share one wrapper div so this list item's
                      space-y-3 sees a single child here rather than two -
                      Tailwind's space-y margin selector only excludes
                      children carrying the HTML "hidden" attribute, not ones
                      merely styled display:none, so two breakpoint-gated
                      siblings would each still count and add a phantom gap.
                      Same reasoning applies to the folded-detail wrapper
                      below. */}
                  <div>
                    <div className="sm:hidden">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 font-medium text-stone-900 dark:text-stone-100">
                          {labelFor(JOB_CATEGORIES, j.category)}
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-stone-700 [font-variant-numeric:tabular-nums] dark:text-stone-300">
                          {feeGlance}
                        </span>
                      </div>
                      {glanceLine2 && (
                        <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">
                          {glanceLine2}
                        </p>
                      )}
                    </div>
                    <div className="hidden flex-wrap items-center gap-2 sm:flex">
                      <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                        {labelFor(JOB_CATEGORIES, j.category)}
                        {/* Locality: open_jobs_for_me (0074) returns the
                            property city. Pros price a lead by where it is. */}
                        {j.city ? (
                          <span className="font-normal text-stone-500 dark:text-stone-400">
                            in {j.city}
                          </span>
                        ) : null}
                      </span>
                      {j.issue_severity && (
                        <span
                          className={`chip border ${SEVERITY_STYLE[j.issue_severity] ?? ""}`}
                        >
                          {j.issue_severity}
                        </span>
                      )}
                      {j.ownership_verified && (
                        <span
                          className="chip-ok"
                          title="The poster's account name matches the county assessor's owner record for this address."
                        >
                          Ownership verified
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-300">
                        {introFee !== null && (
                          <span className="chip border border-hearth-200 bg-hearth-50 font-semibold text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                            First big-ticket lead
                          </span>
                        )}
                        {off > 0 && introFee === null && (
                          <span className="chip border border-amber-200 bg-amber-100 font-semibold text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
                            {off}% off, aging deal
                          </span>
                        )}
                        <span className="[font-variant-numeric:tabular-nums]">
                          Apply fee{" "}
                          {(off > 0 || introFee !== null) && (
                            <span className="text-stone-500 line-through dark:text-stone-400">
                              {baseStr}
                            </span>
                          )}{" "}
                          {feeStr}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Folded detail: description, photos, budget/quality/scope
                      chips, and posted-ago/timing - collapsed by default on
                      phone via a real <details> disclosure, always visible
                      above sm. */}
                  <div>
                    <details className="group sm:hidden">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-medium text-hearth-700 [&::-webkit-details-marker]:hidden dark:text-hearth-300">
                        Details
                        <svg
                          viewBox="0 0 20 20"
                          className="h-4 w-4 transition-transform group-open:rotate-180"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path
                            fillRule="evenodd"
                            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </summary>
                      <div className="mt-2 space-y-3">{detailsContent}</div>
                    </details>
                    <div className="hidden space-y-3 sm:block">{detailsContent}</div>
                  </div>

                  {/* Applicant count: shown on every card so a pro can judge
                      competition before paying the apply fee, not just once
                      the cap is already hit. */}
                  <p
                    className={`text-xs font-semibold ${
                      full ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"
                    }`}
                  >
                    {spots} of {MAX_APPLICANTS_PER_JOB} spots taken
                  </p>

                  {conflict ? (
                    // No apply button: the pro already has this homeowner in
                    // Messages for this trade, so buying a second lead would
                    // just double-charge them for the same relationship. The
                    // card reopens for applying once that job wraps up.
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hearth-200 bg-hearth-50 px-3 py-2 text-sm text-hearth-800 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                      <span>
                        You already have an active{" "}
                        {labelFor(JOB_CATEGORIES, conflict.category)} job with
                        this homeowner.
                      </span>
                      <OpenChatButton
                        leadId={conflict.activeLeadId}
                        name={conflict.homeownerName || "Homeowner"}
                        label="Message them instead"
                      />
                    </div>
                  ) : full ? (
                    <p className="rounded-lg border border-stone-200 bg-stone-100 px-3 py-2 text-center text-sm font-medium text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                      Job full
                    </p>
                  ) : (
                    <ApplyJobButton
                      leadId={j.id}
                      fee={feeStr}
                      feeCents={Math.round(fee * 100)}
                      category={labelFor(JOB_CATEGORIES, j.category)}
                      introPrice={introFee !== null}
                      canAfford={balance >= fee}
                      billingHref={`/pro/billing?need=${Math.max(
                        0,
                        fee - balance
                      ).toFixed(2)}&category=${encodeURIComponent(
                        j.category ?? ""
                      )}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- Active jobs: ones the homeowner picked you for ---- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
            Your jobs <span className="text-stone-500 dark:text-stone-400">({assigned.length})</span>
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Jobs a homeowner chose you for. Their contact is unlocked and you can
            message them.
          </p>
        </div>

        {assigned.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
            No jobs yet. Apply to an open job above and a homeowner can pick you.
          </p>
        ) : (
          <ul className="space-y-3">
            {assigned.map((l) => (
              <AssignedJobCard
                key={l.id}
                l={l}
                photoUrls={assignedPhotos.get(l.id) ?? []}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ---- Applications still waiting on a homeowner's decision ---- */}
      {pendingApps.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Pending applications{" "}
              <span className="text-stone-500 dark:text-stone-400">({pendingApps.length})</span>
            </h2>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Ghost protection: if the homeowner never responds and no one is
              picked, your fee comes back automatically after 7 days, as wallet
              credit for your next application. A single reply from them ends
              it.
            </p>
          </div>
          <ul className="space-y-2">
            {pendingApps.map((a) => (
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
                {a.refunded_at ? (
                  <span className="chip shrink-0 border border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300">
                    Fee back as credit
                  </span>
                ) : (
                  <span className="chip shrink-0 border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
                    Waiting for homeowner
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {declinedApps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Not selected{" "}
            <span className="text-stone-500 dark:text-stone-400">({declinedApps.length})</span>
          </h2>
          {/* The 0106 credit-back promise, stated where the loss lands. */}
          <p className="text-xs text-stone-500 dark:text-stone-400">
            When a homeowner picks someone else, your apply fee comes back as
            wallet credit, good for 60 days. Check your billing page for the
            credit.
          </p>
          <ul className="space-y-2">
            {declinedApps.map((a) => (
              <li
                key={a.application_id}
                className="card flex items-center justify-between gap-3 opacity-70"
              >
                <span className="flex items-center gap-2 font-medium text-stone-700 dark:text-stone-300">
                  {labelFor(JOB_CATEGORIES, a.category)}
                </span>
                <span className="chip shrink-0 border border-stone-200 bg-stone-100 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                  Homeowner chose another pro
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// A job the homeowner picked this pro for: contact revealed + chat + pipeline.
function AssignedJobCard({
  l,
  photoUrls,
}: {
  l: any;
  photoUrls: string[];
}) {
  const scope = scopeChips(l);
  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
          {labelFor(JOB_CATEGORIES, l.category)}
        </span>
        {l.issue_severity && (
          <span
            className={`chip border ${SEVERITY_STYLE[l.issue_severity] ?? ""}`}
          >
            {l.issue_severity}
          </span>
        )}
        <span className={`chip border ${STATUS_STYLE[l.status] ?? ""}`}>
          {STATUS_LABEL[l.status] ?? l.status}
        </span>
      </div>

      {l.issue_description ? (
        <p className="text-sm text-stone-600 dark:text-stone-400">{l.issue_description}</p>
      ) : (
        <p className="text-sm italic text-stone-500 dark:text-stone-400">No details provided yet</p>
      )}

      {/* Major-tier project scope (0114): sq ft / materials as the same muted
          chip, plans/permits as a positive chip-ok. Still worth showing once
          a job is won, not just while bidding on it. */}
      {(scope.length > 0 || l.has_plans_permits === true) && (
        <div className="flex flex-wrap gap-1">
          {scope.map((c) => (
            <span
              key={c}
              className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
            >
              {c}
            </span>
          ))}
          {l.has_plans_permits === true && (
            <span className="chip-ok">Plans/permits in hand</span>
          )}
        </div>
      )}

      {photoUrls.length > 0 && (
        <JobPhotoStrip leadId={l.id} urls={photoUrls} full />
      )}

      <div className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-400">
        <p>
          <span className="text-stone-500 dark:text-stone-400">Homeowner:</span>{" "}
          {l.homeowner_name || "-"}
        </p>
        <p>
          <span className="text-stone-500 dark:text-stone-400">Address:</span>{" "}
          {l.property_address || "-"}
        </p>
        <p className="break-words">
          <span className="text-stone-500 dark:text-stone-400">Contact:</span>{" "}
          {l.homeowner_email || "-"}
          {l.homeowner_phone ? ` · ${l.homeowner_phone}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <OpenChatButton
          leadId={l.id}
          name={l.homeowner_name || "Homeowner"}
          label="Message"
        />
        <JobStatusSelect id={l.id} status={l.status} />
      </div>
    </li>
  );
}
