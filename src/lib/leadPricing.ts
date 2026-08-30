import { PRO_LEAD_DISCOUNT_PCT } from "./constants";

// Aging-lead deals: a job that sits unclaimed gets an automatic markdown on the
// per-apply fee, so pros get a deal and stale inventory clears.
//
// These tiers MUST match supabase/migrations/0031_ghost_protection.sql
// (lead_fee_cents), which is the source of truth for what a pro is actually
// charged. This helper is display-only, so the leads board can advertise the deal.
// (Softened from 25/40% in 0028: ghost protection now covers dead-lead risk, so
// the deep discount double-compensated.)
export const AGING_LEAD_TIERS = [
  { days: 7, off: 30 },
  { days: 3, off: 15 },
] as const;

// Discount percent for a lead given when its job was posted (0 if still fresh).
export function agingDiscountPct(createdAt: string | Date): number {
  const days = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  for (const t of AGING_LEAD_TIERS) if (days >= t.days) return t.off;
  return 0;
}

// Base and effective (post-markdown) fee in dollars, plus the percent off.
export function agingLeadFee(baseFeeDollars: number, createdAt: string | Date) {
  const off = agingDiscountPct(createdAt);
  const fee = Math.round(baseFeeDollars * (100 - off)) / 100;
  return { base: baseFeeDollars, fee, off };
}

// Which single discount priced a lead, mirrored on lead_applications.discount_kind
// (migration 0149) so the wallet ledger can say what actually happened. null
// means no discount applied.
export type LeadDiscountKind = "member" | "aging" | "intro" | null;

// THE ONE PLACE the "best single discount, never stacked" rule lives on the
// TS side. Owner's words: "if they buy [Pro], they start off with a 10%
// discount for leads. It does NOT stack with the 15-30% [aging discount].
// More incentive to buy." Mirrors pro_lead_fee_cents() in migration 0149
// byte for byte: greatest() picks the BIGGER percent (aging tier or the flat
// PRO_LEAD_DISCOUNT_PCT member discount), so a member on an aged lead pays
// whichever deal is bigger, never a combined saving. Ties (both 0) return no
// discount at all; a nonzero tie between the two percents can't happen at
// today's numbers (10 vs. 15/30), but the >= comparison keeps aging as the
// deterministic winner if the numbers ever move, matching the SQL side's
// tie-break exactly.
//
// Deliberately does NOT know about the one-time major-tier intro price
// (src/lib/proLeadCard.ts's introFeeFor): that price is fixed and never
// further discounted, so a caller compares introFeeFor's result against this
// function's `fee` and takes whichever is lower, same as
// major_lead_price_cents()'s least() does in SQL. When intro wins, the
// caller's discount kind becomes "intro", overriding whatever this function
// returned.
export function bestLeadDiscount(
  baseFeeDollars: number,
  createdAt: string | Date,
  isMember: boolean
): { fee: number; off: number; kind: LeadDiscountKind } {
  const agingPct = agingDiscountPct(createdAt);
  const memberPct = isMember ? PRO_LEAD_DISCOUNT_PCT : 0;
  if (agingPct === 0 && memberPct === 0) {
    return { fee: baseFeeDollars, off: 0, kind: null };
  }
  const memberWins = memberPct > agingPct;
  const off = memberWins ? memberPct : agingPct;
  const fee = Math.round(baseFeeDollars * (100 - off)) / 100;
  return { fee, off, kind: memberWins ? "member" : "aging" };
}

