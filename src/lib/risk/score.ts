// The trial-abuse risk score: 0 to 100, with a plain-language reason for every
// point.
//
// SPLIT ON PURPOSE. This file is pure - facts in, score out, no database, no
// clock, no environment - so the weights can be unit tested exactly as they
// will behave in production (src/lib/risk/score.test.ts). The half that talks
// to Postgres lives next door in src/lib/risk/facts.ts, because that one has to
// import the service-role client and "server-only" with it. Nothing in either
// file decides what to DO about a score; that is src/lib/risk/decision.ts.
//
// WHAT IT IS FOR. Both memberships give away a 3-day trial with a card on file.
// The per-account guards (isProTrialEligible, hasClaimedPromo) are exact and
// correct, and they are also completely defeated by making a second account.
// This score is the second layer: it asks whether this "new" account is a
// person we have already met.
//
// WHAT IT IS NOT. It is not evidence, and it is not a fraud verdict. Every
// signal here has an innocent explanation - a family sharing a laptop, two
// roommates on one router, a couple on one credit card, a landlord and a tenant
// at one parcel. Neither band refuses anybody a sale: `medium` and `high` both
// only decline to give away three free days (see src/lib/risk/decision.ts), and
// the only path to a refused checkout is a human writing a 'manual' abuse flag.
//
// THE STRUCTURAL RULE, enforced at the bottom of scoreFromFacts: nothing can
// reach `high` on circumstantial evidence alone. A household of five on one
// wifi, one iPad, one house and one afternoon cannot get there. Reaching `high`
// requires HARD evidence - a shared card, or a link to an account somebody has
// actually charged back or a human has flagged by hand. Everything else is
// capped one point below the line no matter how much of it piles up.

export type RiskLevel = "low" | "medium" | "high";

// One scored observation. `code` is stable and machine-readable so support can
// grep for it; `detail` is the human sentence.
export type RiskReason = {
  code: string;
  points: number;
  detail: string;
};

export type RiskResult = {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
};

// Everything the scoring function is allowed to know. Counting and lookups
// happen in loadRiskFacts; by the time this struct exists there is no ambiguity
// left to resolve.
export type RiskFacts = {
  // A card fingerprint this account has used also sits on another account that
  // has already held a membership, or that has a chargeback against it.
  cardSharedWithUsedOrChargebackAccount: boolean;
  // A card fingerprint this account has used sits on any other account at all.
  cardSharedWithOtherAccount: boolean;
  // TOTAL accounts seen on this device cookie, including this one. 1 means
  // "only this account", which is the normal case and scores nothing.
  accountsOnSameDevice: number;
  // TOTAL accounts seen on this account's IP addresses in the last 7 days,
  // including this one. Same convention as the device count.
  accountsOnSameIpRecently: number;
  // This account shares an IP or a device with an account carrying a CHARGEBACK
  // or a hand-written 'manual' abuse flag. A 'trial_abuse' flag deliberately
  // does NOT feed this (see facts.ts): cancelling inside a free trial is what
  // the product tells people to do, so it is not neighbourhood evidence of
  // anything.
  sharesIpOrDeviceWithFlaggedAccount: boolean;
  // The browser fingerprint matches another account AND that account is also on
  // one of this account's recent IP addresses. Only ever counted together,
  // because the fingerprint alone is a cohort - one popular phone model, in one
  // timezone, in one language is the same five attributes for thousands of
  // people (see src/components/DeviceFingerprint.tsx).
  fingerprintAndIpMatch: boolean;
  // The signup email is at a throwaway-inbox provider.
  disposableEmailDomain: boolean;
  // The signup email, with gmail dots and +tags removed, is the same address as
  // an existing account's.
  emailNormCollision: boolean;
  // How old the account was at the moment this was computed, in minutes. Null
  // when the caller did not supply a creation time.
  accountAgeMinutes: number | null;
  // Minutes between account creation and finishing onboarding (claiming a home
  // or saving a company). Null when onboarding has not happened yet.
  onboardingMinutesAfterSignup: number | null;
  // Another account carries the same phone number.
  samePhoneAsOtherAccount: boolean;
  // Another account claimed the same county parcel, and the two accounts are NOT
  // household co-members (facts.ts subtracts those first: a spouse joining the
  // household is the flow the product asks people to follow).
  sameParcelAsOtherAccount: boolean;
  // Another account registered a company under a normalized-identical name.
  sameCompanyNameAsOtherAccount: boolean;
  // A linked account was flagged for cancelling a subscription while it was
  // still inside its free trial. Computed only over STRONG link kinds (card,
  // device, email_norm, phone) - never over a shared IP, which on carrier NAT
  // means nothing at all.
  linkedToTrialCanceller: boolean;
};

// The weights, in one table, in the order they are applied.
//
// TUNING NOTES (why these numbers and not others):
//
//   The card is the strongest signal by a distance, because it is the one
//   identifier the farmer cannot regenerate for free. A fresh email costs
//   nothing, a fresh device id costs a private window, a fresh IP costs a VPN
//   click - a fresh card costs money or a stolen number.
//
//   So a shared card is pinned to the medium edge deliberately: 40 is exactly
//   MEDIUM_AT, which means "this card is already on another Hearth account", on
//   its own and with nothing else known, always costs the free trial and never
//   costs the sale. That is the whole point of the system in one number. It used
//   to be 35, which is `low`, which meant the single most useful thing this
//   score can ever learn changed nothing at all.
//
//   A card that has already carried a MEMBERSHIP somewhere else, or that sits on
//   an account with a chargeback, is 60: the same no-trial outcome with room
//   above it for a second signal to reach `high`.
//
//   EXCLUSIVE, not cumulative, wherever two rules describe one fact: the two
//   card rules (60 or 40, never 100), the two device bands, the two IP bands,
//   and - added after a household false positive - the account-age band and the
//   fast-onboarding bonus, which are both just "they did it in one sitting".
//   Before that, a spouse who signed up and bought within three minutes paid 25
//   points for one behaviour, and taking an extra 30 seconds over onboarding was
//   the entire difference between two bands.
//
//   Nothing circumstantial reaches `high`, at any pile-up. See the hard-evidence
//   cap at the bottom of scoreFromFacts: a household of five on one wifi, one
//   iPad, one house and one afternoon tops out at 69. `high` needs a card link
//   or a charged-back / hand-flagged neighbour.
const W = {
  cardSharedWithUsedOrChargeback: 60,
  cardSharedWithOther: 40,
  deviceFiveOrMore: 40,
  deviceTwoToFour: 20,
  ipThreeOrMore: 20,
  ipTwo: 10,
  sharedWithFlagged: 40,
  disposableEmail: 25,
  emailNormCollision: 30,
  accountUnder15Min: 15,
  accountUnder2Hours: 5,
  fastOnboarding: 10,
  samePhone: 20,
  // Two accounts on one house used to be 20. It is 10 because the innocent
  // version is not rare, it is the norm: a couple, a parent and an adult child,
  // a landlord and a tenant. facts.ts already subtracts household co-members
  // before this can fire, so what is left is genuinely just "two accounts named
  // the same parcel and never joined a household", which is worth noting and
  // not worth much.
  sameParcel: 10,
  sameCompanyName: 15,
  linkedToTrialCanceller: 25,
  // The fingerprint is deliberately the smallest weight in the table. It is a
  // cohort, not a device (one phone model, one timezone, one language), it is
  // written by page script so the browser owns it, and it only counts at all
  // when the same account also matches on IP.
  fingerprintAndIp: 10,
} as const;

// Band edges. `low` is nothing to see. `medium` and `high` differ only in how
// much is behind them - neither refuses a sale (see src/lib/risk/decision.ts);
// both simply decline to hand over the free 3 days.
export const MEDIUM_AT = 40;
export const HIGH_AT = 70;

// The signals that are allowed to push a score to `high`. Everything else is
// circumstantial: shared networks, shared hardware, shared houses, shared
// trade names, and being new. Each has an innocent explanation that is more
// common than the guilty one, and a pile of them is still a pile of maybes.
//
// A card link is different in kind: cards are not shared by coincidence. So is
// a neighbour who has actually charged back, or one a human has looked at and
// flagged by hand. Without one of those three, scoreFromFacts caps the result
// at HIGH_AT - 1 no matter what else is true.
function hasHardEvidence(facts: RiskFacts): boolean {
  return (
    facts.cardSharedWithUsedOrChargebackAccount ||
    facts.cardSharedWithOtherAccount ||
    facts.sharesIpOrDeviceWithFlaggedAccount
  );
}

export function levelFor(score: number): RiskLevel {
  if (score >= HIGH_AT) return "high";
  if (score >= MEDIUM_AT) return "medium";
  return "low";
}

// The whole scoring rule, pure. Capped at 100 so a pile-on cannot produce a
// number the level bands and any future display would have to explain.
export function scoreFromFacts(facts: RiskFacts): RiskResult {
  const reasons: RiskReason[] = [];
  const add = (code: string, points: number, detail: string) => {
    if (points > 0) reasons.push({ code, points, detail });
  };

  // ---- Card ---------------------------------------------------------------
  if (facts.cardSharedWithUsedOrChargebackAccount) {
    add(
      "card_reused_after_membership",
      W.cardSharedWithUsedOrChargeback,
      "This payment method is already on another account that has held a membership or has a chargeback against it."
    );
  } else if (facts.cardSharedWithOtherAccount) {
    add(
      "card_shared",
      W.cardSharedWithOther,
      "This payment method is already on another account."
    );
  }

  // ---- Device -------------------------------------------------------------
  if (facts.accountsOnSameDevice >= 5) {
    add(
      "device_farm",
      W.deviceFiveOrMore,
      `${facts.accountsOnSameDevice} accounts have been used on this device.`
    );
  } else if (facts.accountsOnSameDevice >= 2) {
    add(
      "device_shared",
      W.deviceTwoToFour,
      `${facts.accountsOnSameDevice} accounts have been used on this device.`
    );
  }

  // ---- Network ------------------------------------------------------------
  if (facts.accountsOnSameIpRecently >= 3) {
    add(
      "ip_cluster",
      W.ipThreeOrMore,
      `${facts.accountsOnSameIpRecently} accounts have used this network in the last week.`
    );
  } else if (facts.accountsOnSameIpRecently === 2) {
    add(
      "ip_pair",
      W.ipTwo,
      "Another account used this network in the last week."
    );
  }

  if (facts.sharesIpOrDeviceWithFlaggedAccount) {
    add(
      "linked_to_flagged",
      W.sharedWithFlagged,
      "This device or network is shared with an account that has charged back or been flagged by hand."
    );
  }

  // The fingerprint, only ever alongside an IP match, and never more than 10.
  // On its own it is a cohort: Safari freezes the iOS user agent, the screen
  // size is the model, the timezone is the county, and the language is en-US -
  // so one popular phone in one metro area is the same hash for thousands of
  // strangers. It is also written by page script, so a browser can put anything
  // it likes there. What it usefully adds is corroboration next to an IP match.
  if (facts.fingerprintAndIpMatch) {
    add(
      "fingerprint_and_network",
      W.fingerprintAndIp,
      "Another account matches this browser profile and has used the same network."
    );
  }

  // ---- Identity -----------------------------------------------------------
  if (facts.disposableEmailDomain) {
    add(
      "disposable_email",
      W.disposableEmail,
      "The email address is at a throwaway-inbox provider."
    );
  }

  if (facts.emailNormCollision) {
    add(
      "email_variant",
      W.emailNormCollision,
      "This email address is a dot or plus-tag variant of an address already on another account."
    );
  }

  // ---- Timing -------------------------------------------------------------
  // "They did the whole thing in one sitting" is ONE fact, so it is scored
  // once: the highest of the three timing rules wins and the others are
  // discarded. It used to be two independent additions, which charged a spouse
  // 25 points (15 + 10) for a single afternoon, and made 30 seconds of
  // hesitation over the onboarding form the entire difference between two
  // bands.
  //
  // None of this is suspicious by itself either - a motivated buyer really does
  // sign up and buy straight away, which is a good outcome, not a bad one. The
  // weight is small and exists to corroborate: a minutes-old account on a
  // device that has seen four others is a different story from either fact
  // alone.
  const timing: Array<[string, number, string]> = [];
  if (facts.accountAgeMinutes !== null) {
    if (facts.accountAgeMinutes < 15) {
      timing.push([
        "account_minutes_old",
        W.accountUnder15Min,
        "The account was created less than 15 minutes before this checkout.",
      ]);
    } else if (facts.accountAgeMinutes < 120) {
      timing.push([
        "account_hours_old",
        W.accountUnder2Hours,
        "The account was created less than 2 hours before this checkout.",
      ]);
    }
  }
  if (
    facts.onboardingMinutesAfterSignup !== null &&
    facts.onboardingMinutesAfterSignup < 2
  ) {
    timing.push([
      "instant_onboarding",
      W.fastOnboarding,
      "Onboarding was completed less than 2 minutes after signup.",
    ]);
  }
  if (timing.length > 0) {
    const [code, points, detail] = timing.reduce((best, next) =>
      next[1] > best[1] ? next : best
    );
    add(code, points, detail);
  }

  // ---- Shared real-world identifiers --------------------------------------
  if (facts.samePhoneAsOtherAccount) {
    add("phone_shared", W.samePhone, "Another account uses this phone number.");
  }
  if (facts.sameParcelAsOtherAccount) {
    add(
      "parcel_shared",
      W.sameParcel,
      "Another account, not a household member of this one, claimed this same property."
    );
  }
  if (facts.sameCompanyNameAsOtherAccount) {
    add(
      "company_name_shared",
      W.sameCompanyName,
      "Another account registered a company under the same name."
    );
  }

  // ---- Known history ------------------------------------------------------
  if (facts.linkedToTrialCanceller) {
    add(
      "linked_trial_canceller",
      W.linkedToTrialCanceller,
      "A linked account cancelled a membership during its free trial."
    );
  }

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  let score = Math.min(100, raw);

  // The hard-evidence cap (see hasHardEvidence above). Circumstantial signals
  // can pile as high as they like and still stop one point short of `high`.
  // This is the structural guarantee, not a tuning choice: without it, a
  // household of five on one wifi, one iPad, one house and one afternoon
  // reaches the top band on nothing but the fact that they live together.
  //
  // The reasons are left intact and a marker is appended, so a support lookup
  // shows both what was seen and that it was deliberately held below the line.
  if (score >= HIGH_AT && !hasHardEvidence(facts)) {
    score = HIGH_AT - 1;
    reasons.push({
      code: "capped_no_hard_evidence",
      points: 0,
      detail:
        "Held below the top band: every signal here is circumstantial (shared network, device, house, or a new account), with no shared card and no charged-back or hand-flagged link.",
    });
  }

  return { score, level: levelFor(score), reasons };
}

// Facts for an account with nothing recorded against it. Used as the fail-open
// answer everywhere a lookup cannot complete, and as the base for tests.
export function emptyFacts(): RiskFacts {
  return {
    cardSharedWithUsedOrChargebackAccount: false,
    cardSharedWithOtherAccount: false,
    accountsOnSameDevice: 1,
    accountsOnSameIpRecently: 1,
    sharesIpOrDeviceWithFlaggedAccount: false,
    fingerprintAndIpMatch: false,
    disposableEmailDomain: false,
    emailNormCollision: false,
    accountAgeMinutes: null,
    onboardingMinutesAfterSignup: null,
    samePhoneAsOtherAccount: false,
    sameParcelAsOtherAccount: false,
    sameCompanyNameAsOtherAccount: false,
    linkedToTrialCanceller: false,
  };
}
