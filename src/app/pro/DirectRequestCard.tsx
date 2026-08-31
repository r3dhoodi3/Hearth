"use client";

// STREAMING FIX, not a behaviour change - same treatment as
// src/app/pro/chats/ChatsView.tsx and src/app/pro/leads/LeadsBoard.tsx, and
// for the same reason (scratchpad/debug-DBG3.md): React Flight defers any
// element it meets once the row it is serializing has passed a 3200-byte
// budget, and each deferral becomes an out-of-order SSR segment - a
// <template id="P:n"> hole plus a late $RS(...) script - which is the shape
// that accompanies the React #418 hydration failure on the pro pages. As one
// client module this card is a single client reference with plain-data props
// wherever it is rendered: the Leads board (inside LeadsBoard) and the two-card
// preview on the pro Home tab.
//
// Nothing here became newly interactive. The only thing that had to move out
// is the posted-ago line: it reads the clock, so recomputing it during
// hydration could disagree with what SSR printed. Both call sites resolve it
// on the server and pass it in.

import {
  labelFor,
  JOB_CATEGORIES,
  TIMING_OPTIONS,
  BUDGET_RANGES,
  isMajorCategory,
} from "@/lib/constants";
import JobPhotoStrip from "./JobPhotoStrip";
import DirectRequestActions from "./DirectRequestActions";
import {
  SEVERITY_STYLE,
  money,
  feeGlanceLabel,
  qualityChips,
  scopeChips,
  introFeeFor,
} from "@/lib/proLeadCard";

// One "Asked for you" card: a homeowner reached out to this pro directly.
//
// Lifted out of src/app/pro/page.tsx unchanged when the pro side split into a
// Home tab and a Leads tab (2026-08-29). The Home tab shows the two newest of
// these as a preview and the Leads board shows all of them, so the card had to
// stop being inline JSX in one page or the two would drift apart the first time
// either got touched. Same markup, same classes, same fee math.
export default function DirectRequestCard({
  d,
  balance,
  hasPaidMajor,
  hasCurrentInsurance = true,
  postedAgoLabel,
}: {
  // The row my_direct_requests hands back: masked, contact-free fields plus a
  // live-priced fee. Untyped for the same reason the board is - the RPC's
  // shape is not in the generated types.
  d: any;
  // The pro's spendable wallet balance in dollars, for the can-afford branch.
  balance: number;
  // Has this pro ever paid for a big-ticket lead? Decides whether the one-time
  // intro price applies. Computed once per page from my_applications.
  hasPaidMajor: boolean;
  // Whether this pro has current insurance on file (big-job gate, migration
  // 0153). Defaults to true so a call site that has not been wired yet shows
  // the unlock button and the server-side gate still refuses - never the
  // other way around (a wrongly hidden button on a covered pro).
  hasCurrentInsurance?: boolean;
  // postedAgo(d.created_at), resolved on the server. Null when there is no
  // usable created_at, exactly as the helper returns.
  postedAgoLabel: string | null;
}) {
  const normalFee = Number(d.fee_cents ?? 0) / 100;
  const introFee = introFeeFor(d.category, normalFee, hasPaidMajor);
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
  // budget/quality/scope chips, posted-ago/timing. Rendered once here and
  // reused below in both the phone <details> and the desktop always-visible
  // div, so the two variants can never drift out of sync.
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
      {/* Major-tier project scope (0114): sq ft / materials as the same muted
          chip, plans/permits as a positive chip-ok. */}
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
      {(postedAgoLabel || d.timing) && (
        <div className="flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
          {postedAgoLabel && (
            <span className="text-xs text-stone-500 dark:text-stone-400">
              {postedAgoLabel}
            </span>
          )}
          {d.timing && <span>Timing: {labelFor(TIMING_OPTIONS, d.timing)}</span>}
        </div>
      )}
    </>
  );

  return (
    <li className="card space-y-3">
      {/* Header: one glanceable line below sm (category + fee, then
          timing/city), the full desktop row at sm+. Both variants share one
          wrapper div so this list item's space-y-3 sees a single child here
          rather than two - Tailwind's space-y margin selector only excludes
          children carrying the HTML "hidden" attribute, not ones merely styled
          display:none, so two breakpoint-gated siblings would each still count
          and add a phantom gap. Same reasoning applies to the folded-detail
          wrapper below. */}
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

      {/* Folded detail: description, photos, budget/quality/scope chips, and
          posted-ago/timing - collapsed by default on phone via a real
          <details> disclosure, always visible above sm. */}
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
        // Big-job insurance gate (0153): a major-tier request cannot be
        // unlocked without current insurance on file, so the actions row
        // swaps the pay button for the requirement (Pass stays available).
        insuranceRequired={isMajorCategory(d.category ?? "") && !hasCurrentInsurance}
        canAfford={balance >= fee}
        billingHref={`/pro/billing?need=${Math.max(0, fee - balance).toFixed(
          2
        )}&category=${encodeURIComponent(d.category ?? "")}`}
      />
    </li>
  );
}
