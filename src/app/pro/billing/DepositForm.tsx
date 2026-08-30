"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import { depositAction } from "./actions";

// Needs its own component because useFormStatus only reports pending state
// inside a descendant of the <form> it belongs to, not the component
// rendering the form itself.
function DepositButton({ disabled, num }: { disabled: boolean; num: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary" disabled={disabled || pending}>
      {pending && <InlineSpinner />}
      Deposit ${num || 0}
    </button>
  );
}

type Tier = { min_cents: number; max_cents: number | null; bonus_pct: number };

// Fallback so the live preview works even if the tiers table didn't load.
const DEFAULT_TIERS: Tier[] = [
  { min_cents: 20000, max_cents: 39999, bonus_pct: 10 },
  { min_cents: 40000, max_cents: 79999, bonus_pct: 15 },
  { min_cents: 80000, max_cents: null, bonus_pct: 20 },
];

// Mirror of the DB apply_deposit() bonus math (integer cents). boostPts is
// the Pro membership boost: extra points on top of the matched tier (and on
// every deposit, even below the entry tier), matching p_bonus_boost_pts in
// migration 0032.
function bonusFor(cents: number, tiers: Tier[], boostPts: number) {
  const t = [...tiers]
    .sort((a, b) => b.min_cents - a.min_cents)
    .find(
      (t) => cents >= t.min_cents && (t.max_cents == null || cents <= t.max_cents)
    );
  const pct = (t?.bonus_pct ?? 0) + Math.max(boostPts, 0);
  return { pct, bonus: Math.floor((cents * pct) / 100) };
}

// Start low: /pros promises "deposits from $5", so the presets open at $50
// with the custom field taking anything from $5 up.
const PRESETS = [50, 100, 200, 400];

export default function DepositForm({
  tiers,
  need,
  boostPts = 0,
  forgoneBoostPts = 0,
}: {
  tiers: Tier[];
  // Dollars still missing for a specific job (?need= from the leads board).
  need?: number;
  // Pro membership deposit boost (percentage points); 0 for non-members.
  boostPts?: number;
  // Points this pro is NOT earning because they have no membership, so the
  // form can name the exact bonus this deposit leaves behind. Zero for anyone
  // who already holds a membership - including one still inside its free
  // trial, whose match is only held back, not forgone (the trial-holdback
  // caveat on /pro/billing owns that case and says so in its own words).
  forgoneBoostPts?: number;
}) {
  // Committed amount (string so the field can be cleared); default to the
  // smallest preset so nobody is nudged into depositing more than they meant
  // to. When the pro came here short on a specific job, preselect the
  // smallest option that covers the shortfall instead (falling back to a
  // custom amount above the largest preset).
  const initialAmount =
    need && need > 0
      ? String(PRESETS.find((p) => p >= need) ?? Math.ceil(need))
      : String(PRESETS[0]);
  const [amount, setAmount] = useState(initialAmount);
  // Preview while hovering a preset - reverts to the committed amount on leave.
  const [hover, setHover] = useState<number | null>(null);
  const [agreed, setAgreed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = hover !== null ? String(hover) : amount;
  const num = Number(shown) || 0;

  const effTiers = tiers.length ? tiers : DEFAULT_TIERS;
  const cents = Math.round(num * 100);
  const { bonus } = bonusFor(cents, effTiers, boostPts);
  const bonusDollars = bonus / 100;
  const totalCredit = (cents + bonus) / 100;
  // What a membership would have added to THIS deposit, at the amount showing
  // right now. Same floor-to-cents math apply_deposit uses, so the number is
  // the one the wallet would really have received, not a rounded pitch.
  const forgoneBonus = Math.floor((cents * Math.max(forgoneBoostPts, 0)) / 100);

  return (
    <form action={depositAction} className="card space-y-4">
      <input type="hidden" name="amount" value={num} />

      {/* The terms come BEFORE any amount is picked: a pro should know
          deposits don't come back before choosing how much to put in.
          12px is under the readable floor on a phone; max-sm:text-sm
          matches the minimum-deposit line below it. */}
      <p className="text-xs text-stone-500 max-sm:text-sm dark:text-stone-400">
        Deposits are non-refundable and can only be spent on leads. Bonus credit
        is promotional, has no cash value, and expires 60 days after it&apos;s
        added. Lead prices vary by service.
      </p>

      {/* Presets, then Custom. Hover a preset to preview; click to set. */}
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => {
          const active = hover !== null ? hover === p : Number(amount) === p;
          return (
            <button
              key={p}
              type="button"
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                setAmount(String(p));
                setHover(null);
              }}
              // Below sm the preset grows to a 44px-tall thumb target. Padding
              // and type are untouched and the rule is behind max-sm, so the
              // chip on a desktop is exactly the chip that was here before.
              className={`rounded-lg border px-3 py-1.5 text-sm max-sm:inline-flex max-sm:min-h-11 max-sm:items-center ${
                active
                  ? "border-hearth-500 bg-hearth-50 text-hearth-800 dark:border-hearth-400 dark:bg-hearth-900/40 dark:text-hearth-200"
                  : "border-stone-200 text-stone-600 hover:border-hearth-300 dark:border-white/10 dark:text-stone-300 dark:hover:border-hearth-400"
              }`}
            >
              ${p}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => inputRef.current?.focus()}
          className="rounded-lg border border-dashed border-stone-300 px-3 py-1.5 text-sm text-stone-500 hover:border-hearth-300 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400"
        >
          Custom
        </button>
      </div>

      <div>
        <label className="label">Deposit amount</label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-stone-500 dark:text-stone-400">$</span>
          <input
            ref={inputRef}
            type="number"
            min={5}
            step={1}
            value={shown}
            placeholder="0"
            // Digits only - no letters, symbols, or emojis.
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            className="input max-w-[120px]"
          />
          {bonus > 0 && (
            <span className="text-sm font-semibold text-green-600 dark:text-green-400">
              + ${bonusDollars.toFixed(2)} bonus
            </span>
          )}
        </div>
        {/* 11px is under the readable floor on a phone, and this line
            states the deposit minimum and the bonus rule. 14px below sm, the
            original size from sm up. */}
        <p className="mt-1 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
          Any amount from $5.{" "}
          {boostPts > 0
            ? `Every deposit earns +${boostPts}% as a Pro member, tiers stack on top`
            : "$200+ earns bonus credit"}
          {bonus > 0 ? ` · $${totalCredit.toFixed(2)} total credit` : ""}.
        </p>
      </div>

      {/* A real, current-amount loss: this deposit, at this size, earns
          exactly this much less than it would with a membership. It moves
          live with the presets, so it is never a number about some other
          deposit. */}
      {forgoneBonus > 0 && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Depositing ${num} without Pro leaves $
          {(forgoneBonus / 100).toFixed(2).replace(/\.00$/, "")} of bonus
          credit on the table this deposit.
        </p>
      )}

      {/* The whole row is the target: on a phone it is 44px tall and the box
          itself is 20px, so agreeing doesn't take a precise tap on a 13px
          checkbox. Both rules sit behind max-sm, so the desktop row is
          unchanged. */}
      <label className="flex items-center gap-2 text-xs text-stone-600 max-sm:min-h-11 dark:text-stone-300">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="accent-hearth-600 max-sm:h-5 max-sm:w-5"
        />
        I understand and agree.
      </label>

      <DepositButton disabled={!agreed || num < 5} num={num} />
    </form>
  );
}
