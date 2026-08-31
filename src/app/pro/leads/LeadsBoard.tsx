"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/app/pro/chats/ChatsView.tsx and src/components/pro/SetupChecklist.tsx,
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
// /pro/leads was the worst of them: measured on a pro with eight assigned
// leads, the page's own Flight row carried THIRTY-ONE deferred references and
// the served document had eight nested holes and nine $RS scripts. Every card
// in every one of the four lists (Asked for you, Open jobs, Your jobs,
// Applications) was another element past the budget.
//
// As one client module the whole board becomes a SINGLE client reference in
// the page's payload carrying plain data - ids, strings, numbers, booleans and
// labels that were already formatted on the server - so there is no element
// left anywhere in that row for Flight to defer. All four sections live in
// here for that reason: leaving any one of them behind in the page would put
// an element after this component's props, which is exactly where the budget
// has already run out.
//
// Nothing here is newly interactive, and nothing is newly computed on the
// client. ApplyJobButton, DirectRequestActions, JobPhotoStrip, JobStatusSelect,
// OpenChatButton and next/link were already client components; everything else
// is static markup rendered from props. Anything that depends on the clock or
// the locale (the aging fee, the posted-ago line, the intro price) is still
// resolved on the server and arrives here as a finished string, so hydration
// cannot disagree with SSR about it.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import OpenChatButton from "@/components/OpenChatButton";
import {
  INSURANCE_REQUIRED_MESSAGE,
  INSURANCE_UPLOAD_HREF,
} from "@/lib/insuranceGate";
import ApplyJobButton from "../ApplyJobButton";
import DirectRequestCard from "../DirectRequestCard";
import JobStatusSelect from "../JobStatusSelect";
import JobPhotoStrip from "../JobPhotoStrip";
import {
  MAX_APPLICANTS_PER_JOB,
  COLD_START_FREE_ALERTS,
  LEAD_TIER_FEES,
  PRO_LEADS_HREF,
} from "@/lib/constants";
import { SEVERITY_STYLE } from "@/lib/proLeadCard";
import {
  LEAD_SORT_OPTIONS,
  normalizeLeadSort,
  sortLeads,
  type LeadSort,
} from "@/lib/leadSort";
import type { LeadDiscountKind } from "@/lib/leadPricing";
import AhaEventReporter from "@/components/AhaEventReporter";
import { AHA_FIRST_LEAD } from "@/lib/trackAhaEvents";
import {
  ghostProtectionGuaranteeRich,
  firstApplicationGuaranteeRich,
  creditNotCashLineRich,
} from "@/lib/guaranteeCopy";
import { proCtaLabel, proTrialSubline } from "@/components/pro/ProUpgradeCta";
import { STATUS_LABEL } from "../leadStatusLabel";

const STATUS_STYLE: Record<string, string> = {
  new: "border-hearth-200 bg-hearth-50 text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300",
  accepted: "border-green-200 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300",
  // Done-and-dusted reads muted so it can't be confused with the active green.
  closed: "border-stone-200 bg-stone-100 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300",
  lost: "border-stone-200 bg-stone-100 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400",
};

// Friendly labels for the pipeline statuses a pro sets on their own jobs.
// Moved to ../leadStatusLabel.ts and imported above (LOW-3): actions.ts's
// status-change toast now reads from the exact same map, so the two can
// never drift ("Won"/"Lost" here vs. a differently-worded toast there).

// One "Asked for you" row. The card itself still takes the raw RPC row (it is
// plain JSON either way); the only thing pulled out is the clock-dependent
// posted-ago line, resolved on the server so SSR and hydration agree.
export type DirectRequestItem = {
  id: string;
  row: any;
  postedAgoLabel: string | null;
};

// One open-job card, fully resolved on the server: the aging/intro fee, every
// label and every chip are computed there so nothing but plain data crosses
// the boundary.
export type OpenJobVM = {
  id: string;
  categoryLabel: string;
  city: string | null;
  severity: string | null;
  ownershipVerified: boolean;
  /** Phone glance line: the fee slot, then timing/city. */
  feeGlance: string;
  glanceLine2: string;
  /** Effective fee, already money()-formatted. */
  feeStr: string;
  /** Pre-markdown fee, shown struck through when a markdown applies. */
  baseStr: string;
  /** Winning discount's percent off, 0 when the listing is still fresh or the intro price won. */
  off: number;
  /** True when the one-time big-ticket intro price is what is being charged. */
  introPrice: boolean;
  /** Which single discount priced this card (never two at once, migration 0149). */
  discountKind: LeadDiscountKind;
  /** "Pro members pay $X" quiet line, already money()-formatted; null when membership would not actually beat this card's price. */
  memberQuoteStr: string | null;
  description: string | null;
  photoUrls: string[];
  budgetLabel: string | null;
  chips: string[];
  scope: string[];
  hasPlansPermits: boolean;
  postedAgoLabel: string | null;
  timingLabel: string | null;
  spots: number;
  full: boolean;
  /** Set when this pro already has an active job with the same homeowner. */
  conflict: {
    categoryLabel: string;
    activeLeadId: string;
    homeownerName: string;
  } | null;
  /** True for a major-tier (big-ticket) category, which requires insurance on file (0153). */
  bigJob: boolean;
  /** True when this is a big job AND the pro has no current insurance on file, so the apply button is withheld. */
  insuranceRequired: boolean;
  feeCents: number;
  canAfford: boolean;
  billingHref: string;
};

// One job the homeowner picked this pro for.
export type AssignedJobVM = {
  id: string;
  categoryLabel: string;
  severity: string | null;
  /** Raw pipeline status, which JobStatusSelect posts back unchanged. */
  status: string;
  description: string | null;
  scope: string[];
  hasPlansPermits: boolean;
  photoUrls: string[];
  /** Display name for the contact block, already defaulted to "-". */
  homeownerName: string;
  /** Same name for the chat dock, defaulted to "Homeowner" instead. */
  chatName: string;
  propertyAddress: string;
  contactLine: string;
};

// One row in the Pending / Not selected lists.
export type ApplicationVM = {
  applicationId: string;
  categoryLabel: string;
  description: string | null;
  refunded: boolean;
};

// "posted 3 days ago" from the postedAgoLabel string ("Posted 3 days ago"),
// so the aging-deal chip reads "15% off, posted 3 days ago" - the actual day
// count this listing has been sitting, not the tier's threshold day count -
// lower-cased so it reads as a clause after the percent, not a new sentence.
// Falls back to a plain phrase if postedAgoLabel is ever missing (defensive
// only: an aging discount cannot exist without a real created_at, so
// postedAgoLabel is always set whenever this chip renders).
function agingDealPhrase(postedAgoLabel: string | null): string {
  return postedAgoLabel
    ? postedAgoLabel.charAt(0).toLowerCase() + postedAgoLabel.slice(1)
    : "aging deal";
}

export default function LeadsBoard({
  lowBalance,
  directRequests,
  balance,
  hasPaidMajor,
  insuranceCurrent,
  openJobs,
  sort,
  hasApplied,
  isProMember,
  proTrialEligible,
  assigned,
  pendingApps,
  declinedApps,
}: {
  lowBalance: boolean;
  directRequests: DirectRequestItem[];
  balance: number;
  hasPaidMajor: boolean;
  /** Whether this pro has current insurance on file (0153), for the big-job gate on direct-request cards. */
  insuranceCurrent: boolean;
  openJobs: OpenJobVM[];
  sort: string;
  /** Whether this pro has ever applied to anything, for the empty state. */
  hasApplied: boolean;
  isProMember: boolean;
  proTrialEligible: boolean;
  assigned: AssignedJobVM[];
  pendingApps: ApplicationVM[];
  declinedApps: ApplicationVM[];
}) {
  // The sort lives here, not on the server. It used to be three links to
  // /pro/leads?sort=..., so every tap re-queried and re-rendered the whole
  // page to reorder a list the browser already had: slow on a phone, and a
  // double tap read as a bug. `sort` is still the order the URL asked for, so
  // the server paints the right one and hydration matches.
  const [activeSort, setActiveSort] = useState<LeadSort>(() =>
    normalizeLeadSort(sort)
  );
  // openJobs is never mutated: "Newest" is simply this array's own order, so
  // switching back to it costs nothing and needs no second request.
  const sortedOpenJobs = useMemo(
    () => sortLeads(openJobs, activeSort),
    [openJobs, activeSort]
  );

  function chooseSort(next: LeadSort) {
    setActiveSort(next);
    // Reflected in the URL, NOT navigated to: replaceState means a reload or
    // a shared link still lands on this order (the server reads ?sort=), while
    // the tap itself costs nothing but a re-render. Next 15 supports
    // history.replaceState here and syncs useSearchParams from it; the
    // existing history.state is passed straight back so the App Router's own
    // entry survives.
    const url =
      next === "new" ? PRO_LEADS_HREF : `${PRO_LEADS_HREF}?sort=${next}`;
    window.history.replaceState(window.history.state, "", url);
  }

  return (
    <>
      {/* One compact line, not a card: the only banner this page still carries
          on its own, so it stays a single sentence rather than the old
          card-plus-button block. */}
      {lowBalance && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
          Low on funds.{" "}
          <Link href="/pro/billing" className="font-medium underline">
            Add funds
          </Link>{" "}
          to keep applying.
        </p>
      )}

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
            {directRequests.map((d) => (
              // The card itself lives in src/app/pro/DirectRequestCard.tsx so
              // the Home tab can show the same two-item preview without a
              // second copy of it drifting away from this one.
              <DirectRequestCard
                key={d.id}
                d={d.row}
                balance={balance}
                hasPaidMajor={hasPaidMajor}
                hasCurrentInsurance={insuranceCurrent}
                postedAgoLabel={d.postedAgoLabel}
              />
            ))}
          </ul>
        </section>
      )}

      {/* First real lead seen is the pro-side aha moment: fires once per
          account when the board has at least one open job (research wave RA,
          2026-08-30; reporter dedupes in localStorage). */}
      <AhaEventReporter event={AHA_FIRST_LEAD} eligible={openJobs.length > 0} />

      {/* ---- Open jobs: posted by homeowners, pay the fee to apply ---- */}
      <section id="open-jobs" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              Open jobs <span className="text-stone-500 dark:text-stone-400">({openJobs.length})</span>
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
              per lead depending on the trade. {ghostProtectionGuaranteeRich()}{" "}
              {firstApplicationGuaranteeRich()} {creditNotCashLineRich()}{" "}
              <Link
                href="/pro/billing"
                className="underline hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:hover:text-stone-300"
              >
                Details on Billing
              </Link>
              .
            </p>
          </div>
          {openJobs.length > 1 && (
            // Buttons, not links: nothing is being navigated to any more. Each
            // one keeps the 44px phone target it had, adds touch-manipulation
            // (no 300ms tap delay) and an active: state so a tap shows
            // instantly, and carries aria-pressed so a screen reader hears
            // which order is on.
            <div className="flex gap-2">
              {LEAD_SORT_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => chooseSort(o.value)}
                  aria-pressed={activeSort === o.value}
                  className={`inline-flex min-h-[44px] touch-manipulation items-center rounded-full border px-3 py-1.5 text-xs transition-colors active:bg-stone-100 sm:inline-block sm:min-h-0 dark:active:bg-white/10 ${
                    activeSort === o.value
                      ? "border-hearth-300 bg-hearth-50 font-medium text-hearth-700 dark:border-hearth-500/40 dark:bg-hearth-500/15 dark:text-hearth-300"
                      : "border-stone-200 text-stone-500 hover:border-stone-300 dark:border-white/10 dark:text-stone-400 dark:hover:border-stone-600"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {openJobs.length === 0 ? (
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
                    className="font-medium text-hearth-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
                  >
                    complete your public page
                  </Link>{" "}
                  (categories, license, logo) so you stand out when jobs
                  arrive.
                </span>
              </li>
              {!hasApplied && (
                <li className="flex items-start gap-2 text-stone-600 dark:text-stone-400">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-hearth-600" aria-hidden="true" />
                  <span>
                    Not chosen? The fee comes back on its own as wallet
                    credit, not cash, spendable on any lead, and it expires
                    after 60 days.{" "}
                    <Link
                      href="/pro/billing"
                      className="font-medium text-hearth-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-hearth-300"
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
            {sortedOpenJobs.map((j) => {
              // Folded detail (0128 phone density pass): description, photos,
              // budget/quality/scope chips, posted-ago/timing. Rendered once
              // here and reused below in both the phone <details> and the
              // desktop always-visible div, so the two variants can never
              // drift out of sync.
              const detailsContent = (
                <>
                  {j.description ? (
                    <p className="text-sm text-stone-600 dark:text-stone-400">
                      {j.description}
                    </p>
                  ) : (
                    <p className="text-sm italic text-stone-500 dark:text-stone-400">
                      No details provided yet
                    </p>
                  )}
                  {j.photoUrls.length > 0 && (
                    <JobPhotoStrip leadId={j.id} urls={j.photoUrls} />
                  )}
                  {(j.chips.length > 0 || j.budgetLabel) && (
                    <div className="flex flex-wrap gap-1">
                      {j.budgetLabel && (
                        <span className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400">
                          Budget: {j.budgetLabel}
                        </span>
                      )}
                      {j.chips.map((c) => (
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
                  {(j.scope.length > 0 || j.hasPlansPermits) && (
                    <div className="flex flex-wrap gap-1">
                      {j.scope.map((c) => (
                        <span
                          key={c}
                          className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
                        >
                          {c}
                        </span>
                      ))}
                      {j.hasPlansPermits && (
                        <span className="chip-ok">Plans/permits in hand</span>
                      )}
                    </div>
                  )}
                  {(j.postedAgoLabel || j.timingLabel) && (
                    <div className="flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
                      {j.postedAgoLabel && (
                        <span className="text-xs text-stone-500 dark:text-stone-400">
                          {j.postedAgoLabel}
                        </span>
                      )}
                      {j.timingLabel && (
                        <span>
                          Timing: {j.timingLabel}
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
                          {j.categoryLabel}
                        </span>
                        {/* The base price struck through and a "Pro" chip
                            ride along on the phone glance line too (not just
                            the desktop row below): a pro should never have to
                            widen their browser to see the deal a card is
                            offering. */}
                        <span className="shrink-0 text-right text-sm font-semibold text-stone-700 [font-variant-numeric:tabular-nums] dark:text-stone-300">
                          {(j.off > 0 || j.introPrice) && (
                            <span className="mr-1 text-xs font-normal text-stone-400 line-through dark:text-stone-500">
                              {j.baseStr}
                            </span>
                          )}
                          {j.feeGlance}
                          {j.discountKind === "member" && (
                            <span className="chip ml-1 border border-hearth-200 bg-hearth-50 align-middle font-semibold text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                              Pro
                            </span>
                          )}
                        </span>
                      </div>
                      {j.glanceLine2 && (
                        // CR3#6: this line sat at the 12px floor; text-sm
                        // reads at 14px, the minimum for phone body text.
                        // Already sm:hidden-scoped, so desktop (which never
                        // rendered this block) is untouched.
                        <p className="mt-0.5 truncate text-sm text-stone-500 dark:text-stone-400">
                          {j.glanceLine2}
                        </p>
                      )}
                    </div>
                    <div className="hidden flex-wrap items-center gap-2 sm:flex">
                      <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                        {j.categoryLabel}
                        {/* Locality: open_jobs_for_me (0074) returns the
                            property city. Pros price a lead by where it is. */}
                        {j.city ? (
                          <span className="font-normal text-stone-500 dark:text-stone-400">
                            in {j.city}
                          </span>
                        ) : null}
                      </span>
                      {j.severity && (
                        <span
                          className={`chip border ${SEVERITY_STYLE[j.severity] ?? ""}`}
                        >
                          {j.severity}
                        </span>
                      )}
                      {j.ownershipVerified && (
                        <span
                          className="chip-ok"
                          title="The name on this account matches the county's public owner record for this address."
                        >
                          Ownership verified
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-300">
                        {j.introPrice && (
                          <span className="chip border border-hearth-200 bg-hearth-50 font-semibold text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                            First big-ticket lead
                          </span>
                        )}
                        {/* Never two badges at once (0149): a card shows
                            EITHER the member discount OR the aging deal,
                            whichever actually won - never both, and never the
                            loser silently applied underneath. */}
                        {j.discountKind === "member" && (
                          <span className="chip border border-hearth-200 bg-hearth-50 font-semibold text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                            Pro
                          </span>
                        )}
                        {j.discountKind === "aging" && (
                          <span className="chip border border-amber-200 bg-amber-100 font-semibold text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
                            {j.off}% off, {agingDealPhrase(j.postedAgoLabel)}
                          </span>
                        )}
                        <span className="[font-variant-numeric:tabular-nums]">
                          Apply fee{" "}
                          {(j.off > 0 || j.introPrice) && (
                            <span className="text-stone-500 line-through dark:text-stone-400">
                              {j.baseStr}
                            </span>
                          )}{" "}
                          {j.feeStr}
                          {j.discountKind === "member" && " with Pro"}
                        </span>
                      </span>
                    </div>
                    {/* The honest "Pro members pay $X" quiet line (marketplace
                        trust: a price change is always a visible line, never
                        a silent adjustment - research-money-R3.md). Lives
                        outside both breakpoint-gated blocks above so it is
                        rendered exactly once for the list item's space-y-3 to
                        count, and only appears when this pro is NOT a member
                        AND membership would actually beat the price already
                        shown - never a number that reads as a saving but
                        would not be one (see memberQuoteStr in page.tsx). */}
                    {j.memberQuoteStr && (
                      <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                        <Link
                          href="/pro/plus?reason=leads"
                          className="underline hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:hover:text-stone-300"
                        >
                          Pro members pay {j.memberQuoteStr}
                        </Link>
                      </p>
                    )}
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
                      the cap is already hit. CR5 remove #3: "X of N spots
                      taken" read as the same blind-bidding pressure pros
                      resent about Angi/HomeAdvisor (pay for a lead, then find
                      out how many others also bought it); Hearth's own
                      guarantees already soften the real risk, so this now
                      reads as transparency, not a countdown - red only once
                      the job is actually full, same as before. */}
                  <p
                    className={`text-xs font-semibold ${
                      j.full ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"
                    }`}
                  >
                    {j.full
                      ? `Full: ${MAX_APPLICANTS_PER_JOB} pros applied`
                      : j.spots === 1
                        ? "1 pro has applied"
                        : `${j.spots} pros have applied`}
                  </p>

                  {j.conflict ? (
                    // No apply button: the pro already has this homeowner in
                    // Messages for this trade, so buying a second lead would
                    // just double-charge them for the same relationship. The
                    // card reopens for applying once that job wraps up.
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hearth-200 bg-hearth-50 px-3 py-2 text-sm text-hearth-800 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
                      <span>
                        You already have an active {j.conflict.categoryLabel} job
                        with this homeowner.
                      </span>
                      <OpenChatButton
                        leadId={j.conflict.activeLeadId}
                        name={j.conflict.homeownerName}
                        label="Message them instead"
                      />
                    </div>
                  ) : j.full ? (
                    <p className="rounded-lg border border-stone-200 bg-stone-100 px-3 py-2 text-center text-sm font-medium text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                      Job full
                    </p>
                  ) : j.insuranceRequired ? (
                    // Big-job insurance gate (0153): no pay button at all
                    // when the requirement is not met, so a pro is told
                    // BEFORE typing a message or confirming a charge. The
                    // server action and the apply_to_lead RPC both refuse
                    // this same case, this card just says it first. Same
                    // card anatomy as the relationship-conflict notice above.
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
                      <span>{INSURANCE_REQUIRED_MESSAGE}</span>
                      <Link
                        href={INSURANCE_UPLOAD_HREF}
                        className="font-medium underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                      >
                        Add insurance
                      </Link>
                    </div>
                  ) : (
                    <>
                      {/* On a big job the requirement is stated even when it
                          is met, so the rule is never a surprise the first
                          time a certificate lapses. */}
                      {j.bigJob && (
                        <p className="text-xs text-stone-500 dark:text-stone-400">
                          Big job: proof of insurance required. Yours is on
                          file.
                        </p>
                      )}
                      <ApplyJobButton
                        leadId={j.id}
                        fee={j.feeStr}
                        feeCents={j.feeCents}
                        category={j.categoryLabel}
                        introPrice={j.introPrice}
                        baseFee={j.off > 0 || j.introPrice ? j.baseStr : null}
                        discountKind={j.discountKind}
                        memberQuoteStr={j.memberQuoteStr}
                        canAfford={j.canAfford}
                        billingHref={j.billingHref}
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- Active jobs: ones the homeowner picked you for ----
          MED-2: id="your-jobs" is the anchor HomeView.tsx's "Active jobs"
          stat links to (../HomeView.tsx). That stat counts THIS list (see
          activeCount in page.tsx: assigned.filter(status not closed/lost)),
          so the anchor has to land here, not on /pro/crm - a separate,
          opt-in client tracker with a different dataset entirely. */}
      <section id="your-jobs" className="space-y-3">
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
              <AssignedJobCard key={l.id} l={l} />
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
              picked, your fee comes back as <strong>wallet credit</strong>{" "}
              after 7 days. One reply from them ends it.
            </p>
          </div>
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
                {a.refunded ? (
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
          {/* The 0107 credit-back promise, stated where the loss lands: every
              applicant here gets their fee back as credit, not just a
              first-timer, so it is rendered from the canonical sentence. */}
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {firstApplicationGuaranteeRich()} {creditNotCashLineRich()} Check
            your billing page for it.
          </p>
          <ul className="space-y-2">
            {declinedApps.map((a) => (
              <li
                key={a.applicationId}
                className="card flex items-center justify-between gap-3 opacity-70"
              >
                <span className="flex items-center gap-2 font-medium text-stone-700 dark:text-stone-300">
                  {a.categoryLabel}
                </span>
                <span className="chip shrink-0 border border-stone-200 bg-stone-100 text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400">
                  Homeowner chose another pro
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// A job the homeowner picked this pro for: contact revealed + chat + pipeline.
function AssignedJobCard({ l }: { l: AssignedJobVM }) {
  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
          {l.categoryLabel}
        </span>
        {l.severity && (
          <span
            className={`chip border ${SEVERITY_STYLE[l.severity] ?? ""}`}
          >
            {l.severity}
          </span>
        )}
        <span className={`chip border ${STATUS_STYLE[l.status] ?? ""}`}>
          {STATUS_LABEL[l.status] ?? l.status}
        </span>
      </div>

      {l.description ? (
        <p className="text-sm text-stone-600 dark:text-stone-400">{l.description}</p>
      ) : (
        <p className="text-sm italic text-stone-500 dark:text-stone-400">No details provided yet</p>
      )}

      {/* Major-tier project scope (0114): sq ft / materials as the same muted
          chip, plans/permits as a positive chip-ok. Still worth showing once
          a job is won, not just while bidding on it. */}
      {(l.scope.length > 0 || l.hasPlansPermits) && (
        <div className="flex flex-wrap gap-1">
          {l.scope.map((c) => (
            <span
              key={c}
              className="chip bg-stone-100 text-stone-600 dark:bg-stone-700 dark:text-stone-400"
            >
              {c}
            </span>
          ))}
          {l.hasPlansPermits && (
            <span className="chip-ok">Plans/permits in hand</span>
          )}
        </div>
      )}

      {l.photoUrls.length > 0 && (
        <JobPhotoStrip leadId={l.id} urls={l.photoUrls} full />
      )}

      <div className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-400">
        <p>
          <span className="text-stone-500 dark:text-stone-400">Homeowner:</span>{" "}
          {l.homeownerName}
        </p>
        <p>
          <span className="text-stone-500 dark:text-stone-400">Address:</span>{" "}
          {l.propertyAddress}
        </p>
        <p className="break-words">
          <span className="text-stone-500 dark:text-stone-400">Contact:</span>{" "}
          {l.contactLine}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OpenChatButton
            leadId={l.id}
            name={l.chatName}
            label="Message"
          />
          {/* Straight into the back-office tools with this job prefilled, so
              the pro does not retype the category and description they are
              looking at (research wave RC, 2026-08-30; the tools page verifies
              the contractor owns the lead before it reads anything). */}
          <Link
            href={`/pro/tools?lead=${l.id}`}
            className="btn-secondary text-sm"
          >
            Estimate
          </Link>
        </div>
        <JobStatusSelect id={l.id} status={l.status} />
      </div>
    </li>
  );
}
