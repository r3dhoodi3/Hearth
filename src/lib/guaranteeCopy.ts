import { createElement, type ReactNode } from "react";
import { GHOST_PROTECTION_DAYS } from "@/lib/constants";

// The two credit-back promises, as one canonical sentence each. They are two
// DIFFERENT triggers and must never blur into one guarantee: ghost protection
// fires when the homeowner never responds, FIRST_APPLICATION_GUARANTEE fires
// when the homeowner responds but picks someone else. Both are unlimited and
// repeat every time.
//
// These live here rather than on any one page because the same promise is
// made in five places (the /pros marketing page, the /pro board, the "not
// selected" list, the billing ledger, and the apply confirm). Wording that
// drifts between those places is a legal problem, not a copy problem, so
// every surface renders these strings verbatim.
//
// Source of truth for the rules: migration 0107
// (supabase/migrations/0107_apply_credit_back.sql), which recreates
// choose_applicant() so EVERY non-chosen applicant with a live, paid fee gets
// 100% of it back as credit, every time, no license required. This
// superseded the older, narrower migration 0044 rule (once per contractor
// ever, first paid application only, license-gated), which 0107's own header
// spells out: "a second or third applicant who lost simply forfeited their
// fee [under 0044]. This makes losing a pick cost the pro nothing [as of
// 0107]." 0044's function still runs as a narrow backstop for a job that
// dies unresolved without ever being picked (closed, expired, or stale 30+
// days) - see the daily cron at
// src/app/api/cron/first-apply-guarantee/route.ts - but it is no longer the
// rule that governs an ordinary "homeowner picked someone else" loss, so this
// file's exported name (kept for the many existing call sites) no longer
// literally matches what its string says. FIRST_APPLICATION_GUARANTEE below
// intentionally states the current, universal 0107 rule, not the legacy
// first-application-only one. Change 0107 (or, for the narrow stale-job
// backstop, 0044) and this file together.

// Says "lead credit" and "(not cash)" in the sentence itself, not just in the
// separate CREDIT_NOT_CASH_LINE below: a pro who reads this line alone (some
// surfaces render it without the follow-on line) should still never come away
// thinking a ghosted lead pays out to a card.
export const GHOST_PROTECTION_GUARANTEE = `If the homeowner never responds within ${GHOST_PROTECTION_DAYS} days, you always get the fee back to your wallet as lead credit (not cash), every time, no limit.`;

export const FIRST_APPLICATION_GUARANTEE =
  "If they do respond but pick someone else, you get 100% of that fee back too, every time, no limit. It lands in your wallet as credit, not cash, and is good for 60 days.";

export const CREDIT_NOT_CASH_LINE =
  "Either way it is Hearth credit in your wallet, not money back to your card.";

// Shown to a pro who has no license number saved yet: the same rule, said as
// the thing they can do about it.
export const FIRST_APPLICATION_NEEDS_LICENSE =
  "Adding your license number unlocks the first-application guarantee.";

// Two more trust lines the 2026-08-30 research wave asked for on /pros and
// the pro help page. Live here for the same reason as the guarantees above:
// one sentence, rendered verbatim everywhere it appears.
//
// NO_CONTRACT_LINE: being listed and applying to jobs costs nothing beyond
// the per-application fee (src/lib/constants.ts LEAD_TIER_FEES, "No
// subscription required" on /pros). The only thing that could read as a
// contract is the optional Pro membership (src/lib/constants.ts PRO_PLAN,
// monthly or yearly), and that cancels from inside the app any time with no
// penalty: src/app/pro/plus/actions.ts cancelProMembershipAction sets
// cancel_at_period_end, it does not charge a fee or require the plan to run
// its term. Say only that; never claim there is no optional membership at
// all.
export const NO_CONTRACT_LINE =
  "No fee just to be listed and no contract to sign: applying to jobs is the only charge. If you add Pro membership, cancel it from your account any time, no penalty.";

// NO_BIDDING_WARS_LINE: every job's fee is fixed by its tier (light, skilled,
// or big-ticket, src/lib/constants.ts LEAD_TIER_FEES) and printed on the
// apply button before payment (src/app/pro/ApplyJobButton.tsx
// ConfirmPayButton, "Confirm and pay {fee}"). There is nothing to bid on and
// no way to see or beat another pro's price, which is what makes "no bidding
// wars" true rather than a slogan.
export const NO_BIDDING_WARS_LINE =
  "No bidding wars, ever: every job has one flat fee for its tier, shown before you tap, never an auction against other pros.";

// The sentence every "License verified" badge must carry: what was checked
// and when. A bare "Verified" chip is a claim with no evidence behind it; the
// public profile page (src/app/p/[id]/page.tsx) already pairs the green
// badge with this exact wording off the real license_verified_at timestamp,
// and every other surface that shows the badge should say the same thing
// instead of a shorter, less accountable version of it. Takes the already-
// formatted date string (each caller formats its own timestamp, matching how
// src/app/p/[id]/page.tsx and src/app/pro/profile/PublicProfileForm.tsx
// already do it) rather than a raw ISO string, so this file never needs a
// date-formatting import of its own.
export function licenseVerifiedOnLine(dateLabel: string): string {
  return `Checked against the CSLB public database on ${dateLabel}.`;
}

// Bolded variants of the three sentences above, for surfaces in the pay-a-fee
// flow (the apply confirm step, the leads board) where the owner wants the
// decisive words impossible to skim past. Wraps exact substrings of the
// canonical strings above, so the words that get bold can never drift from
// the sentence itself - change the wording up there and these still match (or
// throw in dev, see assertPhraseFound, rather than silently stop bolding).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boldPhrases(text: string, phrases: string[]): ReactNode {
  if (process.env.NODE_ENV !== "production") {
    for (const p of phrases) {
      if (!text.includes(p)) {
        throw new Error(`guaranteeCopy: phrase "${p}" not found in "${text}"`);
      }
    }
  }
  const pattern = new RegExp(`(${phrases.map(escapeRegExp).join("|")})`, "g");
  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part, i) =>
      phrases.includes(part) ? createElement("strong", { key: i }, part) : part
    );
}

export function ghostProtectionGuaranteeRich(): ReactNode {
  return boldPhrases(GHOST_PROTECTION_GUARANTEE, [
    "you always get the fee back to your wallet as lead credit (not cash)",
  ]);
}

export function firstApplicationGuaranteeRich(): ReactNode {
  return boldPhrases(FIRST_APPLICATION_GUARANTEE, [
    "you get 100% of that fee back too, every time, no limit",
    "not cash",
  ]);
}

export function creditNotCashLineRich(): ReactNode {
  return boldPhrases(CREDIT_NOT_CASH_LINE, [
    "Hearth credit in your wallet",
    "not money back to your card",
  ]);
}
