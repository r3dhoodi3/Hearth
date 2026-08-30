import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveProperty } from "@/lib/property";
import { getVerifiedUser } from "@/lib/auth";
import {
  computeResponseTimeMinutesBatch,
  formatResponseTime,
} from "@/lib/responseTime";
import {
  BUDGET_RANGES,
  JOB_CATEGORIES,
  TIMING_OPTIONS,
  labelFor,
  COLD_START_FREE_POSTING,
} from "@/lib/constants";
import { hasPlus } from "@/lib/subscription";
import { leadContractorEmbed } from "@/lib/leadJoin";
import {
  postJobAction,
  chooseApplicantAction,
  rehireProAction,
  saveReviewAction,
  cancelDirectRequestAction,
  postDirectPubliclyAction,
} from "./actions";
import { postJobErrorMessage } from "./postJobErrors";
import SubmitButton from "@/components/SubmitButton";
import CategoryFilter from "./CategoryFilter";
import ProjectChips from "./ProjectChips";
import LeadChat from "@/components/LeadChat";
import PhoneInput from "@/components/PhoneInput";
import FadingBanner from "@/components/FadingBanner";
import ScrollIntoViewOnMount from "@/components/ScrollIntoViewOnMount";
import CloseJobButton from "./CloseJobButton";
import EditJobForm from "./EditJobForm";
import PostJobButton from "./PostJobButton";
import StrongPostMeter from "./StrongPostMeter";
import DraftablePhotoUpload from "./DraftablePhotoUpload";
import DescriptionField from "./DescriptionField";
import BudgetField from "./BudgetField";
import ProjectScopeFields from "./ProjectScopeFields";
import { DraftJobProvider } from "./DraftJobContext";
import { budgetBracketForCategory } from "@/lib/health";
import { getOrCreateReferralCode } from "@/lib/referralCode";
import { imgSrc } from "@/lib/storage";
import { licenseVerifiedOnLine } from "@/lib/guaranteeCopy";
import PostJobDoneReferralAsk from "./PostJobDoneReferralAsk";
import PhotoTips from "@/components/PhotoTips";
import ExistingJobPhotos from "./ExistingJobPhotos";
import ReviewButton from "./ReviewButton";
import ContractorReviews from "./ContractorReviews";
import HireAgainButton from "./HireAgainButton";
import ChooseApplicantButton from "./ChooseApplicantButton";
import { ChevronRight } from "lucide-react";
import { redactContact } from "@/lib/redact";
import { isMissingSchemaError } from "@/lib/dbErrors";

// Must match the markers LeadChat posts when either side closes a thread.
//
// This, and NOT contractor_leads.status, is what decides whether the review
// prompt shows. Either side can close a conversation, so it is a fact about
// the job that the homeowner also has a hand in. A draft of migration 0132
// moved the gate to status = 'closed' and was withdrawn: only the pro can set
// that status, so it would have let the reviewed party veto their own reviews.
// leave_review() requires an assigned pro and nothing more.
const isCloseMarker = (b: string) =>
  b.startsWith("Conversation closed") || b === "Chat closed by the contractor.";

export default async function ContractorsPage(
  props: {
    searchParams: Promise<{
      issue?: string;
      category?: string;
      posted?: string;
      desc?: string;
      timing?: string;
      directsent?: string;
      // Why the last post attempt was rejected. postJobAction sets it on
      // every failure path (see postJobErrors.ts); the sentence is rendered
      // under the Post job button.
      error?: string;
      // The budget band a rejected post carried back, so the pick survives
      // the round trip along with the text fields.
      budget?: string;
    }>;
  }
) {
  const searchParams = await props.searchParams;
  const supabase = await createClient();

  // Nothing here depends on anything else on the page (property/plus/auth
  // are all independent lookups) - run them together instead of stacking
  // three round trips before any property- or user-scoped query can start.
  // getVerifiedUser() wraps the same supabase.auth.getUser() network check in
  // React's cache(), so this shares the one verification the (app) layout
  // already paid for instead of opening a second round trip.
  const [property, plus, user] = await Promise.all([
    getActiveProperty(),
    hasPlus(),
    getVerifiedUser(),
  ]);
  if (!property) redirect("/onboarding");

  const category = searchParams.category ?? "";
  // A rejected post comes back here with everything the owner typed plus an
  // ?error= code. Resolved server-side so the reason is in the HTML the phone
  // renders, with no cookie, toast, or timer between the failure and the
  // words on screen.
  const postError = postJobErrorMessage(searchParams.error);
  const issueId = searchParams.issue ?? "";

  // Pre-fill the budget dropdown with a sane bracket when the job arrives tied
  // to a known system or issue (both carry ?category=). Falls back to "" (the
  // "Prefer not to say" option) for a fresh manual post or a category we keep
  // no cost range for, and stays user-changeable either way.
  // searchParams.budget wins when a rejected post carried the owner's own
  // pick back (postJobAction only ever writes a value from BUDGET_RANGES, and
  // it is re-checked here because a URL is a URL). Otherwise the
  // category-derived bracket, as before.
  const budgetDefault = BUDGET_RANGES.some(
    (b) => b.value === searchParams.budget
  )
    ? (searchParams.budget as string)
    : budgetBracketForCategory(category) ?? "";

  // The owner's posted jobs (with the chosen pro's info, if one is picked yet).
  // Cast to any[]: the generated types don't model the contractor_leads ->
  // contractors join, so the nested relation reads as an error type otherwise.
  // owner_closed_at (migration 0092) isn't in the generated types yet either,
  // so the client itself is cast to any for this call, same pattern as the
  // lead_applications reads below.
  // leadContractorEmbed, not a bare "contractors(...)": migration 0105 added a
  // SECOND foreign key from contractor_leads to contractors (direct_to), which
  // made the plain embed ambiguous. PostgREST answers an ambiguous embed with
  // HTTP 300 / PGRST201 and no rows, supabase-js hands that back as `error`,
  // and this page then rendered an empty Your jobs list for every homeowner
  // who had jobs. See src/lib/leadJoin.ts.
  const LEADS_CONTRACTOR_JOIN = leadContractorEmbed(
    "name, rating, review_count, service_area, license_number, contact_phone, contact_email"
  );
  const LEADS_BASE = `id, category, issue_description, issue_id, contractor_id, status, timing, created_at, ${LEADS_CONTRACTOR_JOIN}`;
  const LEADS_SELECT_WITH_CLOSE = `id, category, issue_description, issue_id, contractor_id, status, timing, created_at, owner_closed_at, ${LEADS_CONTRACTOR_JOIN}`;
  // Direct-request columns (migration 0104) on top of owner_closed_at (0092).
  const LEADS_SELECT_FULL = `id, category, issue_description, issue_id, contractor_id, status, timing, created_at, owner_closed_at, direct_to, direct_declined_at, ${LEADS_CONTRACTOR_JOIN}`;

  // These three queries only need property.id / user.id (both already in
  // hand) and are independent of each other, so they run as one parallel
  // wave instead of three stacked round trips.
  const [existingIssuePhotos, { data: profile }, leadsData] =
    await Promise.all([
      // If this job is about an issue that already has photos on file (the
      // "Connect me with a local pro" link from the Issues page carries
      // ?issue=<id>), fetch them so the form can show what will ride along
      // automatically. postJobAction reuses this same issue_id for the lead,
      // so photos already tied to it are already visible to pros with no
      // extra upload step - this is purely about letting the owner SEE that
      // before posting, and remove one if they don't want it sent.
      issueId
        ? supabase
            .from("photos")
            .select("id, url")
            .eq("property_id", property.id)
            .eq("related_type", "issue")
            .eq("related_id", issueId)
            .then((r) => r.data ?? [])
        : Promise.resolve<{ id: string; url: string }[]>([]),
      // Prefill the contact fields from the owner's saved profile.
      supabase
        .from("users")
        .select("full_name, email, phone")
        .eq("id", user?.id ?? "")
        .maybeSingle(),
      (async () => {
        // Cascade the select down as columns go missing, so this never shows
        // an empty jobs list just because a migration hasn't reached this DB:
        // full (0104 direct columns) -> owner_closed_at only (0092) -> base.
        let { data: leadsData, error: leadsError } = await (supabase as any)
          .from("contractor_leads")
          .select(LEADS_SELECT_FULL)
          .eq("property_id", property.id)
          .order("created_at", { ascending: false });
        if (leadsError && isMissingSchemaError(leadsError)) {
          // Migration 0104 hasn't run yet (no direct_to/direct_declined_at):
          // retry with just owner_closed_at.
          let close = await (supabase as any)
            .from("contractor_leads")
            .select(LEADS_SELECT_WITH_CLOSE)
            .eq("property_id", property.id)
            .order("created_at", { ascending: false });
          if (close.error && isMissingSchemaError(close.error)) {
            // Migration 0092 hasn't run either: fall back to the base columns.
            close = await (supabase as any)
              .from("contractor_leads")
              .select(LEADS_BASE)
              .eq("property_id", property.id)
              .order("created_at", { ascending: false });
          }
          leadsData = close.data;
          leadsError = close.error;
        }
        // Anything the cascade could not fix leaves leadsData null, which this
        // page renders as "you have no jobs" - indistinguishable, to the
        // homeowner, from their post having vanished. It stayed silent for the
        // whole life of the PGRST201 ambiguous-embed bug (see leadJoin.ts).
        // Say so in the server log so the next one is found in minutes.
        if (leadsError && !leadsData) {
          console.error(
            "ContractorsPage: contractor_leads read failed, Your jobs will render empty:",
            leadsError.message ?? leadsError
          );
        }
        return leadsData;
      })(),
    ]);
  const leads = (leadsData ?? []) as any[];

  // Direct requests (migration 0104) live in the same contractor_leads table.
  // A PENDING one (aimed at a pro via direct_to, not yet unlocked so
  // contractor_id is still null) belongs in its own card below, NOT the open
  // "Your jobs" board. Once a pro pays to unlock it, contractor_id gets set and
  // it flows into "Your jobs" as a normal assigned job with chat, so the only
  // rows pulled out here are the still-pending ones. On a pre-0104 DB direct_to
  // is undefined on every row, so nothing is pulled out and behavior is
  // unchanged.
  const directRequests = leads.filter((l) => l.direct_to && !l.contractor_id);
  const jobLeads = leads.filter((l) => !(l.direct_to && !l.contractor_id));

  // Same definition the dashboard's "Open jobs" card uses: a posting on this
  // property that no pro has been picked for yet. `leads` is already scoped to
  // property.id (getActiveProperty resolves the signed-in owner's property), so
  // this counts nothing the owner can't already see on this page. Phone only -
  // the dashboard card is max-sm:hidden now, and this strip is where the count
  // lives below sm.
  const openJobsCount = leads.filter((l) => !l.contractor_id).length;

  // The target pro of a pending direct request isn't "related" to this
  // homeowner yet (no assigned lead, no application), so the contractors RLS
  // policy won't let the owner's client read their name. Fetch names via the
  // admin client (already used on this page for reply speed), same as any
  // other cross-homeowner read here.
  const directProById = new Map<
    string,
    { name: string; slug: string | null }
  >();
  if (directRequests.length > 0) {
    const directToIds = Array.from(
      new Set(directRequests.map((l) => l.direct_to as string).filter(Boolean))
    );
    if (directToIds.length > 0) {
      const { data: directPros } = await (createAdminClient() as any)
        .from("contractors")
        .select("id, name, slug")
        .in("id", directToIds);
      for (const c of (directPros ?? []) as {
        id: string;
        name: string;
        slug: string | null;
      }[])
        directProById.set(c.id, { name: c.name, slug: c.slug ?? null });
    }
  }

  // My Pros: distinct pros the homeowner previously hired on this property
  // (accepted = active, closed = completed), most recent job first, so each
  // shows what they were last hired for. `leads` is already newest-first, so
  // the first row seen per contractor is that pro's most recent job.
  const myPros: {
    contractorId: string;
    name: string;
    lastCategory: string;
    lastDescription: string | null;
    rating: number | null;
    reviewCount: number;
  }[] = [];
  const seenContractors = new Set<string>();
  for (const l of leads) {
    if (!l.contractor_id) continue;
    if (l.status !== "accepted" && l.status !== "closed") continue;
    if (seenContractors.has(l.contractor_id)) continue;
    seenContractors.add(l.contractor_id);
    myPros.push({
      contractorId: l.contractor_id,
      name: l.contractors?.name ?? "Your pro",
      lastCategory: l.category,
      lastDescription: l.issue_description ?? null,
      rating: l.contractors?.review_count > 0 ? l.contractors.rating : null,
      reviewCount: l.contractors?.review_count ?? 0,
    });
  }

  // Figure out which jobs are finished (chat-closed) and which already have a
  // review, so the row can show a "Leave a review" / "Edit review" button.
  // Scoped to the displayed jobs: pending direct requests carry no
  // applications, reviews, or chat, so they never need these lookups.
  const leadIds = jobLeads.map((l) => l.id);
  const reviewByLead = new Map<
    string,
    { rating: number; comment: string | null }
  >();
  const closedIds = new Set<string>();
  // Applications on the owner's jobs, with each applying pro's public info.
  // lead_applications isn't in the generated types yet, so query via any.
  const appsByLead = new Map<string, any[]>();
  // The issue behind each job, if any (a lead posted straight from Issues
  // carries issue_id; one typed with no issue link has none). Feeds
  // firstPhotoByLead below - RB wave, CR4#2: the post-review share prompt
  // also offers a before/after photo when the job had one attached.
  const issueIds = Array.from(
    new Set(
      jobLeads.map((l) => l.issue_id).filter((id): id is string => Boolean(id))
    )
  );
  const firstPhotoByLead = new Map<string, string>();
  if (leadIds.length) {
    // None of these four depend on each other - only on leadIds/issueIds -
    // so they run as one parallel wave instead of four stacked round trips.
    const [{ data: revs }, { data: sys }, { data: apps }, { data: pics }] =
      await Promise.all([
        supabase
          .from("reviews")
          .select("lead_id, rating, comment")
          .in("lead_id", leadIds),
        supabase
          .from("messages")
          .select("lead_id, body, created_at")
          .eq("sender_role", "system")
          .in("lead_id", leadIds)
          .order("created_at", { ascending: false }),
        (supabase as any)
          .from("lead_applications")
          .select(
            "id, lead_id, contractor_id, message, created_at, status, refunded_at, contractors(name, rating, review_count, service_area, license_number, license_verified_at, logo_url)"
          )
          .in("lead_id", leadIds)
          .order("created_at", { ascending: true }),
        issueIds.length
          ? supabase
              .from("photos")
              .select("related_id, url")
              .eq("related_type", "issue")
              .eq("property_id", property.id)
              .in("related_id", issueIds)
              .order("uploaded_at", { ascending: true })
          : Promise.resolve({ data: [] as { related_id: string; url: string }[] }),
      ]);
    for (const r of revs ?? [])
      reviewByLead.set(r.lead_id, { rating: r.rating, comment: r.comment });

    const lastSys = new Map<string, any>();
    for (const m of sys ?? []) if (!lastSys.has(m.lead_id)) lastSys.set(m.lead_id, m);
    for (const [lid, m] of lastSys)
      if (isCloseMarker(m.body)) closedIds.add(lid);

    for (const a of (apps ?? []) as any[]) {
      const list = appsByLead.get(a.lead_id) ?? [];
      list.push(a);
      appsByLead.set(a.lead_id, list);
    }

    // First photo per issue, then mapped onto every lead that issue backs -
    // this page's own photo grid (ExistingJobPhotos) already treats "first
    // uploaded" as the lead photo, so the share prompt agrees with what the
    // homeowner sees while posting. Stored through imgSrc(), same as
    // ExistingJobPhotos does: the bucket is private, so the raw stored value
    // (a bare object path, sometimes a legacy public-URL string) is never
    // fetchable as-is - it has to go through the authenticated /api/img proxy.
    const firstPhotoByIssue = new Map<string, string>();
    for (const p of pics ?? []) {
      if (firstPhotoByIssue.has(p.related_id)) continue;
      const served = imgSrc(p.url);
      if (served) firstPhotoByIssue.set(p.related_id, served);
    }
    for (const l of jobLeads) {
      if (!l.issue_id) continue;
      const url = firstPhotoByIssue.get(l.issue_id);
      if (url) firstPhotoByLead.set(l.id, url);
    }
  }

  // The homeowner's own invite link, fetched (and lazily generated) only
  // when it will actually be used: at least one job on this page has been
  // marked done. See PostJobDoneReferralAsk.tsx for why this is a separate,
  // once-per-account prompt from the review flow's own share panels.
  const postJobReferralCode = closedIds.size > 0 ? await getOrCreateReferralCode() : null;

  // Which job card gets the full "Your job is live..." explainer, and which
  // ones get one compact line instead.
  //
  // That explainer is a ~200px dashed box, and it used to render inside EVERY
  // awaiting job card. Four open jobs made this page about 3900px tall on a
  // phone, repeating the same paragraph and the same photo tip four times. It
  // is a first-post explanation, not a per-job status, so it renders once, on
  // the newest awaiting job - jobLeads comes back created_at descending, so
  // that is the one just posted, the only reader who needs it. Every other
  // awaiting job says "Live. No applications yet." on one line.
  const explainerLeadId = jobLeads.find(
    (l: any) =>
      !l.contractor_id &&
      !l.owner_closed_at &&
      (appsByLead.get(l.id) ?? []).length === 0
  )?.id as string | undefined;

  // Reply-speed line on each applicant card: one batched computation for
  // every applying pro across every job on this page (never one query per
  // pro, never one query per job). Needs the admin client - a pro's reply
  // history spans jobs posted by other homeowners too, which this
  // homeowner's own RLS-scoped client has no way to read.
  const applicantContractorIds = Array.from(
    new Set(
      Array.from(appsByLead.values())
        .flat()
        .map((a: any) => a.contractor_id)
        .filter(Boolean)
    )
  );
  const replyMinutesByContractor =
    applicantContractorIds.length > 0
      ? await computeResponseTimeMinutesBatch(
          createAdminClient(),
          applicantContractorIds
        )
      : new Map<string, number | null>();

  // One truncated review snippet per applicant card: the most recent review
  // that actually has text. One batched read for every applying pro across the
  // page instead of a contractor_reviews RPC call per applicant. Needs the
  // admin client - reviews are written by other homeowners, so this owner's
  // RLS-scoped client can't read them directly (the RPC is SECURITY DEFINER for
  // exactly that reason). Ordered newest-first, so the first row with text per
  // contractor is that pro's most recent written review; blanks are skipped so
  // the snippet is never empty. Only applicants that have real reviews.
  const reviewSnippetByContractor = new Map<string, string>();
  const snippetContractorIds = Array.from(
    new Set(
      Array.from(appsByLead.values())
        .flat()
        .filter((a: any) => a.contractor_id && a.contractors?.review_count > 0)
        .map((a: any) => a.contractor_id as string)
    )
  );
  if (snippetContractorIds.length > 0) {
    const { data: snippetRows } = await (createAdminClient() as any)
      .from("reviews")
      .select("contractor_id, comment, created_at")
      .in("contractor_id", snippetContractorIds)
      .order("created_at", { ascending: false });
    for (const r of (snippetRows ?? []) as {
      contractor_id: string;
      comment: string | null;
    }[]) {
      // Rows arrive newest-first, so the first one carrying text wins and any
      // later (older) rows for the same pro are ignored.
      if (reviewSnippetByContractor.has(r.contractor_id)) continue;
      const comment = (r.comment ?? "").trim();
      if (comment.length > 0) {
        reviewSnippetByContractor.set(r.contractor_id, comment);
      }
    }
  }

  return (
    <div className="space-y-8">
      <div>
        {/* Phone only: the dashboard's "Open jobs" card is hidden below sm, so
            this is where the count lives now. Sits INSIDE this wrapper, not as
            a sibling of it, on purpose: as a sibling it would take the parent's
            space-y-8 margin and push the h1 down 32px on desktop, where it is
            display:none and should cost nothing at all. */}
        {openJobsCount > 0 && (
          <Link
            href="#your-jobs"
            className="focus-ring mb-4 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2 shadow-sm sm:hidden dark:border-white/10 dark:bg-stone-800"
          >
            <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
              {openJobsCount} open job{openJobsCount === 1 ? "" : "s"}
            </span>
            <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-bark-700 dark:text-stone-300">
              View
              <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </span>
          </Link>
        )}
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Post a job</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Describe what you need and post it. Local pros apply, then you review
          them and pick the one you want.
        </p>
      </div>

      {/* Phone only: the "Thinking about a project?" chips moved off the home
          page (too much scrolling) to here, where they are one tap into the
          form directly below - each chip reloads this page with ?category=x,
          which prefills "What do you need?". Desktop still has them on the
          dashboard, so this copy is sm:hidden and shares the same component.
          Collapsed by default behind a <details>: all 22 chips shown open
          overwhelmed the page above the form, so phone visitors now open
          them on purpose instead of scrolling past them first. */}
      <details className="sm:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg border border-stone-200 bg-white px-3 text-sm font-medium text-stone-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300">
          Popular projects
          <span aria-hidden="true" className="text-stone-400">▾</span>
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Popular upgrades. Tap one to fill in the form below.
          </p>
          <ProjectChips />
        </div>
      </details>

      {searchParams.posted && (
        // The confirmation that a post actually landed. Three things about it
        // are deliberate, and each one is a thing that went wrong when this
        // banner lived at the bottom of the page:
        //
        //   ABOVE the form, not below it. The form resets on every ?posted
        //   (its key is tied to that param), so a reader who tapped Post is
        //   looking straight at a blank form. The explanation has to be in
        //   that same eyeful, not 2000px further down past My Pros and the
        //   upsell.
        //
        //   It does not fade. The old one was a FadingBanner that deleted
        //   itself 7 seconds after mount, and the smooth scroll that was
        //   supposed to reveal it was still fighting Next's scroll-to-top
        //   while that timer ran. It stays until the owner navigates.
        //
        //   It says where the job went. "Job posted" is not enough: a tester
        //   who saw exactly that still could not find their job, because the
        //   phone dashboard's Open jobs card is hidden and Your jobs is far
        //   below the fold. The link to #your-jobs is the answer to the
        //   question the banner otherwise leaves open. The same anchor backs
        //   the phone-only "N open jobs / View" strip at the top of this page,
        //   whose count comes from the leads query above and so includes the
        //   job that was just posted (postJobAction revalidates /contractors
        //   before it redirects).
        // scroll-mt goes on the ScrollIntoViewOnMount wrapper, not on the box
        // inside it: the wrapper is the element scrollIntoView is called on, so
        // scroll-margin anywhere else is inert. It was on the inner div, which
        // is why the page landed at scrollY ~361 with "Your job is live" tucked
        // up under the sticky header. 5rem clears that header at every width
        // (py-2.5 + a 44px row on a phone, py-3 above sm).
        <ScrollIntoViewOnMount className="scroll-mt-20">
          <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 shadow-sm dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
            <p className="font-medium">
              Your job is live. Pros can see it now.
            </p>
            <p className="mt-1">
              Find it under{" "}
              {/* The one thing to tap in this banner, and it measured 63x17.
                  max-sm gives it a 44px-tall box while keeping it inline in
                  the sentence (align-middle so it does not shove the line);
                  desktop keeps the plain inline link. */}
              <Link
                href="#your-jobs"
                className="focus-ring font-medium underline underline-offset-2 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:align-middle"
              >
                Your jobs
              </Link>{" "}
              further down this page. We&apos;ll notify you the moment a pro
              applies. Honest note: Hearth is still new in some areas, so if
              applications are slow it&apos;s our pro coverage catching up, not
              a problem with your post.
            </p>
          </div>
        </ScrollIntoViewOnMount>
      )}

      <form
        key={searchParams.posted ?? "new"}
        action={postJobAction}
        className="card space-y-4"
      >
        <DraftJobProvider initialCategory={category}>
        <input type="hidden" name="issue_id" value={issueId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="job-category">
              What do you need?
            </label>
            <CategoryFilter category={category} id="job-category" />
          </div>
          <div>
            <label className="label" htmlFor="job-timing">
              Preferred timing
            </label>
            <select
              name="timing"
              id="job-timing"
              className="select"
              defaultValue={searchParams.timing || "few_weeks"}
            >
              {TIMING_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="homeowner-name">
              First and last name
            </label>
            <input
              name="homeowner_name"
              id="homeowner-name"
              className="input"
              placeholder="Jane Doe"
              defaultValue={profile?.full_name ?? ""}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="homeowner-email">
              Email (optional)
            </label>
            <input
              name="homeowner_email"
              id="homeowner-email"
              type="email"
              className="input"
              placeholder="you@example.com"
              defaultValue={profile?.email ?? user?.email ?? ""}
            />
          </div>
          <div>
            <label className="label" htmlFor="homeowner-phone">
              Phone (optional)
            </label>
            <PhoneInput
              name="homeowner_phone"
              id="homeowner-phone"
              defaultValue={profile?.phone ?? ""}
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              So pros can reach you faster (optional).
            </p>
          </div>
        </div>

        <DescriptionField initialDescription={searchParams.desc ?? ""} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            {existingIssuePhotos.length > 0 && (
              <ExistingJobPhotos photos={existingIssuePhotos} />
            )}
            <DraftablePhotoUpload propertyId={property.id} id="job-photos" />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              Pros quote more accurately when they can see the job.
            </p>
            <PhotoTips />
          </div>
          <BudgetField category={category} defaultValue={budgetDefault} />
        </div>

        <ProjectScopeFields category={category} />

        <StrongPostMeter />

        <PostJobButton serverError={postError} />
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Your contact stays private. Only the pro you choose from the applicants
          gets your name, address, and contact details.
        </p>
        </DraftJobProvider>
      </form>

      {myPros.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">My Pros</h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Already worked with someone great? Hire them again, free, no
              apply fee.
            </p>
          </div>
          <ul className="space-y-2">
            {myPros.map((p) => (
              <li
                key={p.contractorId}
                className="card flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-stone-900 dark:text-stone-100">
                    {p.name}
                    {p.rating != null && (
                      <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                        ★ {p.rating}
                        <span className="text-stone-500 dark:text-stone-400">
                          {" "}
                          · {p.reviewCount} review{p.reviewCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    )}
                  </p>
                  <p className="truncate text-sm text-stone-500 dark:text-stone-400">
                    Last hired for {labelFor(JOB_CATEGORIES, p.lastCategory)}
                    {p.lastDescription ? `: ${p.lastDescription}` : ""}
                  </p>
                </div>
                <HireAgainButton
                  contractorId={p.contractorId}
                  contractorName={p.name}
                  lastCategory={p.lastCategory}
                  action={rehireProAction}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* COLD START: while posting is free and uncapped for everyone, the
          "3 open jobs" upsell would be false advertising, so it stays hidden.
          Flip COLD_START_FREE_POSTING to bring it back with the cap. */}
      {!COLD_START_FREE_POSTING && !plus && (
        <div className="card flex items-center justify-between gap-4 border-bark-100 bg-bark-50 dark:border-bark-700/40 dark:bg-bark-700/30">
          <div>
            <p className="font-medium text-bark-700 dark:text-stone-300">
              Juggling more than one project?
            </p>
            <p className="text-sm text-bark-700 dark:text-stone-300">
              Free covers 3 open jobs at a time. Hearth Plus is unlimited, plus
              priority matching so pros see yours first. Start weekly with a
              3-day free trial, or go monthly at $4.99.
            </p>
          </div>
          <Link href="/plus" className="btn-primary shrink-0">
            Line up more pros
          </Link>
        </div>
      )}

      {/* The success banner used to live HERE, below the form, My Pros and
          the upsell, wrapped in a FadingBanner that removed itself 7 seconds
          after mount and reached only by a smooth scroll racing Next's own
          scroll-to-top after the redirect. On a phone that meant a reader who
          had just tapped Post saw a blank, reset form and, often, no banner at
          all - three testers on 2026-08-28 read that as the post silently
          failing, and one of them had actually posted successfully. It now
          renders directly above the form and stays put; see there. */}

      {searchParams.directsent && (
        <ScrollIntoViewOnMount>
          <FadingBanner
            delay={2500}
            fadeMs={4500}
            className="scroll-mt-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 shadow-sm dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
          >
            Request sent. Only this pro can see it. If they accept, they get your
            contact and a chat opens. If they pass, you can post it to all local
            pros from the card below.
          </FadingBanner>
        </ScrollIntoViewOnMount>
      )}

      {/* id="your-jobs": the dashboard's "View job postings" link (openJobsCount
          > 0, which counts every lead with no contractor_id yet, direct
          requests included) lands here directly. It has to sit on a wrapper
          around BOTH sections below, not just the "Your jobs" one further
          down: a homeowner whose only open job is a pending direct request
          has jobLeads.length === 0 (direct-only leads are filtered OUT of
          jobLeads above), so an id scoped to just that section would render
          nothing at all for that homeowner - the exact bug this fixes.
          leads.length > 0 is equivalent to directRequests.length > 0 ||
          jobLeads.length > 0 (the two are a full, disjoint partition of
          `leads`), so this wrapper renders in every case openJobsCount > 0
          can occur, plus the (harmless) case of jobs that are all
          closed/chosen.

          searchParams.posted is in the condition for one reason: the success
          banner above links to #your-jobs by name. A banner pointing at an
          anchor that is not in the document is worse than no banner - the
          homeowner taps "Your jobs", nothing moves, and they conclude the post
          did not land. So whenever the banner is on screen, this wrapper is
          too, and the section below says something even if the list came back
          empty. */}
      {(directRequests.length > 0 ||
        jobLeads.length > 0 ||
        Boolean(searchParams.posted)) && (
        <div id="your-jobs" className="scroll-mt-4 space-y-8">
      {/* Pending direct requests (migration 0104): a request aimed at one
          specific pro that they haven't accepted yet. Kept out of "Your jobs"
          above until a pro unlocks it. */}
      {directRequests.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Requests to specific pros
            </h2>
            <p className="text-sm text-stone-500 dark:text-stone-400">
              Only the pro you asked can see these. If they pass, post the job
              to all local pros instead.
            </p>
          </div>
          <ul className="space-y-2">
            {directRequests.map((l) => {
              const pro = directProById.get(l.direct_to);
              const proName = pro?.name ?? "This pro";
              const declined = Boolean(l.direct_declined_at);
              return (
                <li key={l.id} className="card space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-stone-900 dark:text-stone-100">
                        {labelFor(JOB_CATEGORIES, l.category)}
                        {" · "}
                        {pro?.slug || l.direct_to ? (
                          <Link
                            href={`/p/${pro?.slug ?? l.direct_to}`}
                            className="hover:underline"
                          >
                            {proName}
                          </Link>
                        ) : (
                          proName
                        )}
                      </p>
                      {l.issue_description && (
                        <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                          {l.issue_description}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                        Sent {new Date(l.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 ${declined ? "chip-muted" : "chip-warn"}`}
                    >
                      {declined ? `${proName} passed` : `Waiting on ${proName}`}
                    </span>
                  </div>

                  {declined && (
                    <p className="rounded-lg border border-dashed border-stone-300 p-3 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
                      {proName} passed on this one. Post it to all local pros and
                      matching pros can apply.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <form action={postDirectPubliclyAction}>
                      <input type="hidden" name="lead_id" value={l.id} />
                      <SubmitButton
                        className="btn-primary text-sm"
                        pendingLabel="Posting…"
                      >
                        Post publicly instead
                      </SubmitButton>
                    </form>
                    <form action={cancelDirectRequestAction}>
                      <input type="hidden" name="lead_id" value={l.id} />
                      <SubmitButton
                        className="btn-secondary text-sm"
                        pendingLabel="Cancelling…"
                      >
                        Cancel
                      </SubmitButton>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Renders nothing when there are no jobs yet; posting the first one
          is handled by the form above, not this section. The id lives on the
          wrapper above now (see the comment there for why). */}
      {jobLeads.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Your jobs</h2>
          <ul className="space-y-3">
            {jobLeads.map((l) => {
              const apps = appsByLead.get(l.id) ?? [];
              const chosen = Boolean(l.contractor_id);
              // closeJobAction only counts and notifies LIVE applicants
              // (status 'applied', not yet ghost-refunded), so the close
              // copy should match that, not the raw application count.
              const liveApplicantCount = apps.filter(
                (a: any) => a.status === "applied" && !a.refunded_at
              ).length;
              // Closed by the owner without picking anyone (migration 0092):
              // status/contractor_id are untouched by this, so `chosen` still
              // reads correctly even for a job closed this way.
              const closedByOwner = !chosen && Boolean(l.owner_closed_at);
              return (
                <li key={l.id} className="card space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-medium text-stone-900 dark:text-stone-100">
                        {labelFor(JOB_CATEGORIES, l.category)}
                      </span>
                      {l.issue_description && (
                        <p className="text-sm text-stone-500 dark:text-stone-400">
                          {l.issue_description}
                        </p>
                      )}
                    </div>
                    <span className="chip-muted shrink-0">
                      {chosen
                        ? "Pro selected"
                        : closedByOwner
                        ? "Closed"
                        : `${apps.length} applicant${apps.length === 1 ? "" : "s"}`}
                    </span>
                  </div>

                  {!chosen && !closedByOwner && <EditJobForm job={l} />}

                  {chosen ? (
                    // A pro has been picked: show them + open the message thread.
                    <div className="space-y-2">
                      <div className="rounded-lg bg-stone-50 p-3 text-sm dark:bg-stone-700">
                        <p className="font-medium text-stone-900 dark:text-stone-100">
                          {l.contractors?.name ?? "Your pro"}
                          {l.contractors?.review_count > 0 ? (
                            <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                              ★ {l.contractors.rating}
                              <span className="text-stone-500 dark:text-stone-400">
                                {" "}
                                · {l.contractors.review_count} review
                                {l.contractors.review_count === 1 ? "" : "s"}
                              </span>
                            </span>
                          ) : null}
                        </p>
                        <p className="break-words text-stone-500 dark:text-stone-400">
                          {l.contractors?.contact_phone || ""}
                          {l.contractors?.contact_email
                            ? ` · ${l.contractors.contact_email}`
                            : ""}
                        </p>
                        {l.contractors?.review_count > 0 && (
                          <ContractorReviews
                            contractorId={l.contractor_id}
                            count={l.contractors.review_count}
                          />
                        )}
                      </div>
                      <LeadChat leadId={l.id} role="homeowner" />

                      {/* Review the pro once the conversation has been closed.
                          Both branches keep the SAME tree shape (outer div >
                          flex div > [content, ReviewButton]) so React updates
                          ReviewButton in place when the post-submit
                          revalidation flips this row from "no review" to
                          "reviewed": a shape change here would remount it and
                          wipe the just-shown "Share your pro" card. */}
                      {closedIds.has(l.id) && (
                        <div
                          className={
                            reviewByLead.has(l.id)
                              ? "rounded-lg border border-stone-200 p-3 dark:border-white/10"
                              : "rounded-lg border border-dashed border-stone-300 p-3 dark:border-stone-700"
                          }
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            {reviewByLead.has(l.id) ? (
                              <div className="text-sm">
                                <span className="text-amber-500">
                                  {"★".repeat(reviewByLead.get(l.id)!.rating)}
                                  <span className="text-stone-300 dark:text-stone-600">
                                    {"★".repeat(
                                      5 - reviewByLead.get(l.id)!.rating
                                    )}
                                  </span>
                                </span>
                                {reviewByLead.get(l.id)!.comment && (
                                  <p className="mt-0.5 text-stone-500 dark:text-stone-400">
                                    {reviewByLead.get(l.id)!.comment}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-sm text-stone-500 dark:text-stone-400">
                                Job wrapped up? Leave{" "}
                                {l.contractors?.name ?? "your pro"} a review.
                              </p>
                            )}
                            <ReviewButton
                              leadId={l.id}
                              contractorName={l.contractors?.name ?? "your pro"}
                              action={saveReviewAction}
                              existing={reviewByLead.get(l.id)}
                              proProfilePath={`/p/${l.contractor_id}`}
                              categoryLabel={labelFor(JOB_CATEGORIES, l.category)}
                              photoUrl={firstPhotoByLead.get(l.id) ?? null}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : closedByOwner ? (
                    // Owner closed the job without picking anyone (migration
                    // 0092): status is still 'new' underneath, so the applicants
                    // still refund on the normal ghost-protection schedule -
                    // this is purely the UI reflecting that decision.
                    <div className="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
                      You closed this job without choosing a pro.
                      {apps.length > 0
                        ? " Applicants who already paid to apply were notified, and their fee comes back to them as Hearth credit automatically if you haven't picked anyone within a week of applying."
                        : ""}
                    </div>
                  ) : apps.length === 0 ? (
                    <div className="space-y-2">
                      {/* Only the newest awaiting job carries the explainer
                          (see explainerLeadId above for why). The others say
                          the same status in one line, which is all a second
                          or third open job actually needs. */}
                      {l.id !== explainerLeadId ? (
                        <p className="text-sm text-stone-500 dark:text-stone-400">
                          {l.timing === "asap"
                            ? "Live and marked urgent. No applications yet."
                            : "Live. No applications yet."}
                        </p>
                      ) : (
                      <div className="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
                        {/* An asap job shouldn't be told "a day or two": point
                            a real emergency at faster help instead. */}
                        {l.timing === "asap" ? (
                          <p>
                            Your job is live and marked urgent. For active
                            flooding or gas, don&apos;t wait: call a 24/7 pro
                            directly, and use the{" "}
                            <Link
                              href="/emergency"
                              className="font-medium text-bark-700 hover:underline dark:text-stone-300"
                            >
                              Emergency page
                            </Link>{" "}
                            for shutoff steps.
                          </p>
                        ) : (
                          <p>
                            Your job is live. Pros usually apply within a day or
                            two; we&apos;ll notify you the moment one does.
                          </p>
                        )}
                        {/* Photos ride on the lead's issue (photos rows keyed
                            to issue_id), so a lead with no issue_id definitely
                            has none. When issue_id exists we can't tell
                            without another query, so the tip stays quiet. */}
                        {!l.issue_id && (
                          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                            Tip: adding photos or more detail helps pros decide
                            to apply and quote accurately.
                          </p>
                        )}
                      </div>
                      )}
                      <CloseJobButton leadId={l.id} />
                    </div>
                  ) : (
                    // Review the applicants and pick one, or close the job
                    // without picking anyone (see closeJobAction for why that
                    // no longer refuses once applicants exist).
                    <div className="space-y-2">
                      <ul className="space-y-2">
                        {apps.map((a) => (
                        <li
                          key={a.id}
                          className="rounded-lg border border-stone-200 p-3 dark:border-white/10"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex min-w-0 gap-3">
                              {/* Small avatar: the pro's logo when they have
                                  one, else a neutral initial chip. */}
                              {a.contractors?.logo_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={a.contractors.logo_url}
                                  alt={`${a.contractors?.name ?? "Pro"} logo`}
                                  className="h-9 w-9 shrink-0 rounded-lg bg-white object-cover ring-1 ring-stone-200 dark:ring-white/10"
                                />
                              ) : (
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-stone-200 bg-stone-50 text-sm font-semibold text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                                  {(a.contractors?.name ?? "P").slice(0, 1).toUpperCase()}
                                </div>
                              )}
                              <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                {/* Name links to the pro's full public page
                                    (/p/<id>, new tab) so the owner can see
                                    reviews and project photos before choosing.
                                    Falls back to plain text if this row somehow
                                    has no contractor_id. */}
                                {a.contractor_id ? (
                                  <a
                                    href={`/p/${a.contractor_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-medium text-stone-900 hover:underline dark:text-stone-100"
                                  >
                                    {a.contractors?.name ?? "A pro"}
                                  </a>
                                ) : (
                                  <span className="font-medium text-stone-900 dark:text-stone-100">
                                    {a.contractors?.name ?? "A pro"}
                                  </span>
                                )}
                                {a.contractors?.review_count > 0 ? (
                                  <span className="text-xs text-amber-600 dark:text-amber-400">
                                    ★ {a.contractors.rating}
                                    <span className="text-stone-500 dark:text-stone-400">
                                      {" "}
                                      · {a.contractors.review_count} review
                                      {a.contractors.review_count === 1 ? "" : "s"}
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-xs text-stone-500 dark:text-stone-400">
                                    New
                                  </span>
                                )}
                              </div>
                              {a.contractors?.review_count > 0 && (
                                <ContractorReviews
                                  contractorId={a.contractor_id}
                                  count={a.contractors.review_count}
                                />
                              )}
                              {/* One most-recent review snippet, one line, so
                                  the card carries a real voice without opening
                                  the full list. Only when the pro has reviews
                                  with text (fetched server-side above). */}
                              {reviewSnippetByContractor.get(a.contractor_id) && (
                                <p className="truncate text-xs italic text-stone-500 dark:text-stone-400">
                                  &ldquo;{reviewSnippetByContractor.get(a.contractor_id)}&rdquo;
                                </p>
                              )}
                              {a.contractors?.service_area && (
                                <p className="text-xs text-stone-500 dark:text-stone-400">
                                  {a.contractors.service_area}
                                </p>
                              )}
                              {/* License trust: same honest distinction as the
                                  public profile (/p/<id>). A real CSLB-checked
                                  license (license_verified_at, migration 0055)
                                  gets the green "License verified" badge; a
                                  license the pro merely typed in gets the
                                  neutral gray "License on file" badge so it can
                                  never be mistaken for the verified one. The
                                  raw number stays visible either way so a wary
                                  owner can look it up at cslb.ca.gov. */}
                              {a.contractors?.license_verified_at ? (
                                <p className="mt-1">
                                  <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                                    <svg
                                      viewBox="0 0 24 24"
                                      className="h-3 w-3"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M20 6L9 17l-5-5" />
                                    </svg>
                                    License verified
                                  </span>
                                  <span className="ml-1.5 text-xs text-stone-500 dark:text-stone-400">
                                    {a.contractors?.license_number
                                      ? `Lic. ${a.contractors.license_number} · `
                                      : ""}
                                    {/* Same wording as the public profile page's
                                        badge (src/lib/guaranteeCopy.ts): what was
                                        checked and when, not a bare "Checked". */}
                                    {licenseVerifiedOnLine(
                                      new Date(
                                        a.contractors.license_verified_at
                                      ).toLocaleDateString("en-US", {
                                        month: "long",
                                        day: "numeric",
                                        year: "numeric",
                                      })
                                    )}
                                  </span>
                                </p>
                              ) : a.contractors?.license_number ? (
                                <p className="mt-1">
                                  <span className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300">
                                    <svg
                                      viewBox="0 0 24 24"
                                      className="h-3 w-3"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 15l2 2 4-4" />
                                    </svg>
                                    License on file
                                  </span>
                                  <span className="ml-1.5 text-xs text-stone-500 dark:text-stone-400">
                                    Lic. {a.contractors.license_number} ·
                                    Reported by the business, not verified.
                                  </span>
                                </p>
                              ) : (
                                <p className="mt-1">
                                  {/* Honest neutral empty state: nothing on
                                      file and no CSLB match. Muted, not
                                      alarming - states the fact, not a flag. */}
                                  <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs font-medium text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                                    No license listed
                                  </span>
                                </p>
                              )}
                              {formatResponseTime(
                                replyMinutesByContractor.get(a.contractor_id) ??
                                  null
                              ) && (
                                <p className="mt-1">
                                  <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
                                    {formatResponseTime(
                                      replyMinutesByContractor.get(
                                        a.contractor_id
                                      ) ?? null
                                    )}
                                  </span>
                                </p>
                              )}
                              {a.message && (
                                <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
                                  {redactContact(a.message)}
                                </p>
                              )}
                              </div>
                            </div>
                            <form action={chooseApplicantAction}>
                              <input
                                type="hidden"
                                name="application_id"
                                value={a.id}
                              />
                              <ChooseApplicantButton
                                contractorName={a.contractors?.name ?? "this pro"}
                              />
                            </form>
                          </div>
                        </li>
                      ))}
                      </ul>
                      <CloseJobButton leadId={l.id} applicantCount={liveApplicantCount} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* MR3#12 / CR4#7: the referral ask for the moment a job actually got
          done, separate from ReviewButton's own post-rating share panels.
          One card for the whole page, not one per closed job - see
          postJobReferralCode above for why it's only fetched when needed. */}
      <PostJobDoneReferralAsk code={postJobReferralCode} />

      {/* The just-posted job did not come back in the read above. That is a
          server-side fault (see the console.error on the leads query), not
          anything the homeowner did, and the one thing they must not be told
          is nothing: the banner has just sent them here by name. Say what is
          true - the job is saved, this list could not be loaded - and give
          them the one action that fixes it. */}
      {jobLeads.length === 0 && searchParams.posted && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Your jobs
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Your job is saved and pros can see it. We couldn&apos;t load your
            job list just now.{" "}
            <Link
              href="/contractors"
              className="focus-ring font-medium underline underline-offset-2"
            >
              Reload this page
            </Link>{" "}
            to see it.
          </p>
        </section>
      )}
        </div>
      )}

      <p className="text-center text-sm text-stone-500 dark:text-stone-400">
        <Link href="/issues" className="hover:underline">
          ← Back
        </Link>
      </p>
    </div>
  );
}
