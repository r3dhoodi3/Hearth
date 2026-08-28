import "server-only";
import { computeRisk, loadEnforcementState } from "./facts";
import type { RiskLevel } from "./score";

// The one place that turns a risk score into an answer about money.
//
// Two questions, one call:
//   allowCheckout - may this account start a paid membership at all?
//   allowTrial    - may it start on the free 3 days?
//
// WHAT EACH BAND ACTUALLY COSTS SOMEBODY:
//
//   low     Nothing changes. This is the overwhelming majority.
//
//   medium  The membership is still for sale; the giveaway is not. They are
//           charged from day one instead of day four. Nothing is refused, no
//           feature is withheld, and the auto-renewal disclosure they consent to
//           states the immediate charge, so nothing they were shown is untrue.
//           Silent by design: no reason is ever displayed. Explaining the rule
//           teaches a farmer how to walk around it, and the alternative - naming
//           a signal - states a guess as if it were a fact.
//
//   high    ALSO just "no free trial". It is not a refusal. It differs from
//           medium only in that it is logged loudly (console.error with the user
//           id and the reasons) so the operator can actually see what the score
//           is doing to real people in the Vercel logs.
//
// SO WHAT EVER REFUSES A SALE? Exactly one thing: a 'manual' abuse flag, written
// by a human who looked at an account and decided. The score cannot put anybody
// there by itself, at any number. That is deliberate. Refusing a sale is the
// most expensive mistake this system can make, the evidence it works from is
// circumstantial by nature, and there is nobody staffing an appeals queue. The
// allowCheckout:false path is kept wired up for that manual tier and for a
// future reviewed tier - it is not dead code, it is just not something a
// heuristic gets to trigger.
//
// TWO OVERRIDES, CHECKED IN ORDER, BOTH BEFORE THE SCORE:
//
//   1. public.risk_overrides - a hand-written per-account row (migration 0130).
//      Absolute in both directions. This is the whole admin surface: one insert
//      from the Supabase SQL editor, statement written out in the PASTE-ME file.
//
//   2. RISK_ENFORCE - the log-only switch. While it is unset or "false" (the
//      DEFAULT, and how this ships), the score is computed and STORED on every
//      checkout but the trial is always granted. That is the point: it lets the
//      first week of real traffic answer "what would this have done to my
//      customers" from account_risk before it is allowed to do it. Turn it on
//      only once the level-distribution query in the PASTE-ME file looks sane.
//
// IT FAILS OPEN. Every lookup underneath this is best-effort, and if the whole
// thing falls over - migration 0130 not applied, RISK_HASH_SALT not set,
// database unreachable - the answer is low/allow/allow. That is the opposite of
// how isProTrialEligible and hasClaimedPromo behave, and deliberately so: those
// two enforce an exact, per-account rule where failing closed costs a farmer
// their second trial, while this one is a heuristic where failing closed costs
// real customers their sale. The exact guards are still there underneath; this
// is a second layer, not a replacement for the first.

export type TrialDecision = {
  allowTrial: boolean;
  allowCheckout: boolean;
  level: RiskLevel;
  score: number;
};

// The answer for an account nothing is known about, and the answer whenever
// anything goes wrong.
const ALLOW_ALL: TrialDecision = {
  allowTrial: true,
  allowCheckout: true,
  level: "low",
  score: 0,
};

// The copy shown when checkout is refused (today: only a 'manual' abuse flag
// gets here). Exported so the two checkout actions and any test reference the
// one string instead of retyping it. It names no signal and gives no number, and
// it points at a human, because the honest form of a judgement call is an
// invitation to argue with it.
export const RISK_BLOCK_MESSAGE =
  "We can't offer a membership on this account right now. Contact us if you think this is a mistake.";

// Is enforcement on? Defaults to OFF. Anything other than an explicit "true"
// (case-insensitive) is off, so a typo in the env var fails to the safe side
// rather than silently enforcing.
export function riskEnforcementEnabled(): boolean {
  return (process.env.RISK_ENFORCE ?? "").trim().toLowerCase() === "true";
}

// HOW LONG A RENDER-PATH DECISION MAY BE REUSED.
//
// The two /plus pages run this only to pick which sentence to print (see the
// long note above: log-only by default, and startPlusCheckoutAction re-runs the
// whole thing with persist:true before a card is ever charged). Recomputing the
// ~10 service-role queries underneath on every refresh of an upsell page buys
// nothing, so a render-path caller may opt into reusing an answer this fresh.
//
// The store is a module-level Map, which on serverless means it only ever warms
// ONE instance: a second concurrent lambda has its own empty Map and simply
// recomputes. That is the point - it is a latency shave for the refresh /
// back-button case, never a source of truth. Nothing reads it that spends money.
export const TRIAL_DECISION_TTL_MS = 10 * 60 * 1000;

// A hard ceiling so a long-lived warm instance can never grow this without
// bound. Evicts the oldest inserted key, which is good enough for a cache whose
// entries all expire in ten minutes anyway.
const DECISION_CACHE_MAX = 500;

const decisionCache = new Map<string, { at: number; decision: TrialDecision }>();

// Test seam. Not used by app code.
export function __clearTrialDecisionCache(): void {
  decisionCache.clear();
}

// WHAT NEVER GETS STORED, and why. Both of these are the decisions that cost
// somebody something, and both are meant to be recomputed and re-observed every
// single time they are asked for:
//
//   level "high"           the top band exists to be LOGGED loudly on every
//                          occurrence (console.error below). Serving it from a
//                          cache would silence nine out of ten of those lines
//                          and hide the verdict from the operator.
//   allowCheckout false    only a human-written 'manual' abuse flag reaches
//                          here. If an operator clears that flag, the next read
//                          must see it cleared, not a ten-minute-old refusal.
//
// The fail-open answer from the catch below is not stored either: a transient
// outage must not pin an optimistic verdict in place for ten minutes.
function cacheable(decision: TrialDecision): boolean {
  return decision.level !== "high" && decision.allowCheckout;
}

function remember(userId: string, decision: TrialDecision): void {
  if (!cacheable(decision)) {
    // Also drop any older entry, so a now-high account cannot keep being served
    // the low answer it was given nine minutes ago.
    decisionCache.delete(userId);
    return;
  }
  if (decisionCache.size >= DECISION_CACHE_MAX) {
    const oldest = decisionCache.keys().next();
    if (!oldest.done) decisionCache.delete(oldest.value);
  }
  decisionCache.set(userId, { at: Date.now(), decision });
}

export async function trialDecision(
  userId: string,
  opts: {
    accountCreatedAt?: string | null;
    persist?: boolean;
    // Opt-in, and OFF by default: the checkout actions pass nothing and so
    // always compute a fresh, authoritative decision. Only a page render (which
    // decides copy, not money) should ever set this.
    maxAgeMs?: number;
  } = {}
): Promise<TrialDecision> {
  if (!userId) return ALLOW_ALL;

  const maxAgeMs = opts.maxAgeMs ?? 0;
  if (maxAgeMs > 0) {
    const hit = decisionCache.get(userId);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.decision;
  }

  try {
    const decision = await computeDecision(userId, opts);
    if (maxAgeMs > 0) remember(userId, decision);
    return decision;
  } catch (err) {
    // See the fail-open note above: a broken risk check must never cost a real
    // customer a sale. Logged loudly, because a check that is quietly always
    // returning "allow" is worse than not having one. Deliberately NOT stored:
    // a transient outage must not pin an optimistic verdict in place for the
    // whole TTL.
    console.error("trialDecision failed - allowing checkout and trial:", err);
    return ALLOW_ALL;
  }
}

async function computeDecision(
  userId: string,
  opts: { accountCreatedAt?: string | null; persist?: boolean }
): Promise<TrialDecision> {
  const { overrideAllowTrial, manualBlock } = await loadEnforcementState(userId);

  // A human said no. The only path in the system to a refused sale.
  if (manualBlock) {
    return {
      allowTrial: false,
      allowCheckout: false,
      level: "high",
      score: 100,
    };
  }

  // A human said yes (or no) about the trial specifically. Short-circuits the
  // score entirely - there is no point computing a number nobody will read.
  if (overrideAllowTrial !== null) {
    return {
      allowTrial: overrideAllowTrial,
      allowCheckout: true,
      level: overrideAllowTrial ? "low" : "medium",
      score: 0,
    };
  }

  const { score, level, reasons } = await computeRisk(userId, opts);

  // The top band is a logging event, not an enforcement event. If this shows
  // up in the Vercel logs next to a customer who then emails support, that is
  // the feedback loop the weights need.
  if (level === "high") {
    console.error(
      "[risk] high",
      JSON.stringify({
        userId,
        score,
        enforcing: riskEnforcementEnabled(),
        reasons: reasons.map((r) => `${r.code}:${r.points}`),
      })
    );
  }

  // Log-only mode: compute, store, grant the trial anyway.
  if (!riskEnforcementEnabled()) {
    return { allowTrial: true, allowCheckout: true, level, score };
  }

  return {
    allowTrial: level === "low",
    // The score never refuses a sale. See the note at the top of this file.
    allowCheckout: true,
    level,
    score,
  };
}
