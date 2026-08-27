import { describe, it, expect } from "vitest";
import {
  scoreFromFacts,
  emptyFacts,
  levelFor,
  MEDIUM_AT,
  HIGH_AT,
  type RiskFacts,
} from "./score";

// The weights are money: `medium` takes the free trial away and `high` refuses
// the sale outright, so every number in src/lib/risk/score.ts is pinned here.
// If a weight moves, one of these fails and whoever moved it has to say why.

function facts(overrides: Partial<RiskFacts> = {}): RiskFacts {
  return { ...emptyFacts(), ...overrides };
}

function points(overrides: Partial<RiskFacts> = {}): number {
  return scoreFromFacts(facts(overrides)).score;
}

function codes(overrides: Partial<RiskFacts> = {}): string[] {
  return scoreFromFacts(facts(overrides)).reasons.map((r) => r.code);
}

describe("scoreFromFacts: a clean account", () => {
  it("scores zero with no reasons", () => {
    const result = scoreFromFacts(emptyFacts());
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.level).toBe("low");
  });

  it("treats one account on one device and one network as normal", () => {
    expect(points({ accountsOnSameDevice: 1, accountsOnSameIpRecently: 1 })).toBe(0);
  });
});

describe("scoreFromFacts: individual weights", () => {
  it("card on another account that already held a membership: 60", () => {
    expect(points({ cardSharedWithUsedOrChargebackAccount: true })).toBe(60);
  });

  it("card on any other account: 40, exactly the medium edge", () => {
    // Deliberately pinned to MEDIUM_AT. "This card is already on another Hearth
    // account" is the single most useful thing this system can learn, and at 35
    // it scored as low, which meant it changed nothing at all.
    expect(points({ cardSharedWithOtherAccount: true })).toBe(40);
    expect(scoreFromFacts(facts({ cardSharedWithOtherAccount: true })).level).toBe(
      "medium"
    );
  });

  it("5 or more accounts on one device: 40", () => {
    expect(points({ accountsOnSameDevice: 5 })).toBe(40);
    expect(points({ accountsOnSameDevice: 12 })).toBe(40);
  });

  it("2 to 4 accounts on one device: 20", () => {
    expect(points({ accountsOnSameDevice: 2 })).toBe(20);
    expect(points({ accountsOnSameDevice: 4 })).toBe(20);
  });

  it("3 or more accounts on one network in a week: 20", () => {
    expect(points({ accountsOnSameIpRecently: 3 })).toBe(20);
    expect(points({ accountsOnSameIpRecently: 9 })).toBe(20);
  });

  it("exactly 2 accounts on one network in a week: 10", () => {
    expect(points({ accountsOnSameIpRecently: 2 })).toBe(10);
  });

  it("device or network shared with a flagged account: 40", () => {
    expect(points({ sharesIpOrDeviceWithFlaggedAccount: true })).toBe(40);
  });

  it("disposable email domain: 25", () => {
    expect(points({ disposableEmailDomain: true })).toBe(25);
  });

  it("dot or plus-tag variant of an existing address: 30", () => {
    expect(points({ emailNormCollision: true })).toBe(30);
  });

  it("account under 15 minutes old: 15", () => {
    expect(points({ accountAgeMinutes: 0 })).toBe(15);
    expect(points({ accountAgeMinutes: 14 })).toBe(15);
  });

  it("account under 2 hours old: 5", () => {
    expect(points({ accountAgeMinutes: 15 })).toBe(5);
    expect(points({ accountAgeMinutes: 119 })).toBe(5);
  });

  it("an older account scores nothing for its age", () => {
    expect(points({ accountAgeMinutes: 120 })).toBe(0);
    expect(points({ accountAgeMinutes: 60 * 24 * 30 })).toBe(0);
  });

  it("onboarding finished under 2 minutes after signup: 10", () => {
    expect(points({ onboardingMinutesAfterSignup: 0.5 })).toBe(10);
    expect(points({ onboardingMinutesAfterSignup: 1.9 })).toBe(10);
    expect(points({ onboardingMinutesAfterSignup: 2 })).toBe(0);
  });

  it("a fingerprint match that ALSO matches on network: 10", () => {
    // The smallest weight in the table, and it only exists in this combined
    // form. A fingerprint on its own is a cohort, not a device.
    expect(points({ fingerprintAndIpMatch: true })).toBe(10);
  });

  it("same phone as another account: 20", () => {
    expect(points({ samePhoneAsOtherAccount: true })).toBe(20);
  });

  it("same parcel as another account: 10", () => {
    // Halved from 20: the innocent version (a couple, a parent and an adult
    // child, a landlord and a tenant) is not rare, it is the norm. facts.ts also
    // subtracts household co-members before this can fire at all.
    expect(points({ sameParcelAsOtherAccount: true })).toBe(10);
  });

  it("same normalized company name as another account: 15", () => {
    expect(points({ sameCompanyNameAsOtherAccount: true })).toBe(15);
  });

  it("linked to an account that cancelled inside its trial: 25", () => {
    expect(points({ linkedToTrialCanceller: true })).toBe(25);
  });
});

describe("scoreFromFacts: the exclusive bands never double-count", () => {
  it("uses the stronger card rule only, never both", () => {
    const result = scoreFromFacts(
      facts({
        cardSharedWithUsedOrChargebackAccount: true,
        cardSharedWithOtherAccount: true,
      })
    );
    expect(result.score).toBe(60);
    expect(result.reasons.map((r) => r.code)).toEqual([
      "card_reused_after_membership",
    ]);
  });

  it("uses one device band, not two", () => {
    expect(codes({ accountsOnSameDevice: 6 })).toEqual(["device_farm"]);
    expect(codes({ accountsOnSameDevice: 3 })).toEqual(["device_shared"]);
  });

  it("uses one network band, not two", () => {
    expect(codes({ accountsOnSameIpRecently: 4 })).toEqual(["ip_cluster"]);
    expect(codes({ accountsOnSameIpRecently: 2 })).toEqual(["ip_pair"]);
  });

  it("uses one account-age band, not two", () => {
    expect(codes({ accountAgeMinutes: 3 })).toEqual(["account_minutes_old"]);
    expect(codes({ accountAgeMinutes: 90 })).toEqual(["account_hours_old"]);
  });

  it("scores 'did the whole thing in one sitting' ONCE, not twice", () => {
    // Account age and instant onboarding are one behaviour seen from two
    // angles. Charging both cost an honest spouse 25 points for one afternoon.
    const oneSitting = { accountAgeMinutes: 3, onboardingMinutesAfterSignup: 1 };
    expect(points(oneSitting)).toBe(15); // max(15, 10), not 25
    expect(codes(oneSitting)).toEqual(["account_minutes_old"]);
  });

  it("takes the LARGER of the timing rules when they disagree", () => {
    // An older account that onboarded instantly: 10 beats 5, so the onboarding
    // reason is the one that survives.
    const slowSignupFastOnboard = {
      accountAgeMinutes: 90,
      onboardingMinutesAfterSignup: 1,
    };
    expect(points(slowSignupFastOnboard)).toBe(10);
    expect(codes(slowSignupFastOnboard)).toEqual(["instant_onboarding"]);
  });

  it("no longer turns 30 seconds of hesitation into a different outcome", () => {
    // The old scoring made 2.5 minutes of onboarding worth 10 fewer points than
    // 1.5 minutes, which was the entire difference between two bands.
    const quick = { accountAgeMinutes: 3, onboardingMinutesAfterSignup: 1.5 };
    const slower = { accountAgeMinutes: 3, onboardingMinutesAfterSignup: 2.5 };
    expect(points(quick)).toBe(points(slower));
  });

  it("scores nothing for account age when it is unknown", () => {
    expect(points({ accountAgeMinutes: null })).toBe(0);
    expect(points({ onboardingMinutesAfterSignup: null })).toBe(0);
  });
});

describe("scoreFromFacts: levels", () => {
  it("puts the band edges where decision.ts expects them", () => {
    expect(MEDIUM_AT).toBe(40);
    expect(HIGH_AT).toBe(70);
    expect(levelFor(0)).toBe("low");
    expect(levelFor(39)).toBe("low");
    expect(levelFor(40)).toBe("medium");
    expect(levelFor(69)).toBe("medium");
    expect(levelFor(70)).toBe("high");
    expect(levelFor(100)).toBe("high");
  });

  it("leaves a single shared card in medium, never high", () => {
    // A couple paying for two accounts on one card must still be able to buy.
    const result = scoreFromFacts(facts({ cardSharedWithUsedOrChargebackAccount: true }));
    expect(result.level).toBe("medium");
  });

  it("leaves a single disposable inbox in low", () => {
    expect(scoreFromFacts(facts({ disposableEmailDomain: true })).level).toBe("low");
  });

  it("reaches high when a card link stacks with anything else", () => {
    const result = scoreFromFacts(
      facts({
        cardSharedWithUsedOrChargebackAccount: true, // 60, hard evidence
        accountAgeMinutes: 5, // 15
      })
    );
    expect(result.score).toBe(75);
    expect(result.level).toBe("high");
  });

  it("reaches high on a device farm next to a charged-back account", () => {
    const result = scoreFromFacts(
      facts({
        accountsOnSameDevice: 6, // 40
        sharesIpOrDeviceWithFlaggedAccount: true, // 40, hard evidence
      })
    );
    expect(result.score).toBe(80);
    expect(result.level).toBe("high");
  });
});

describe("scoreFromFacts: the cap", () => {
  it("never exceeds 100 even with everything on", () => {
    const everything: RiskFacts = {
      cardSharedWithUsedOrChargebackAccount: true,
      cardSharedWithOtherAccount: true,
      accountsOnSameDevice: 20,
      accountsOnSameIpRecently: 20,
      sharesIpOrDeviceWithFlaggedAccount: true,
      fingerprintAndIpMatch: true,
      disposableEmailDomain: true,
      emailNormCollision: true,
      accountAgeMinutes: 1,
      onboardingMinutesAfterSignup: 0,
      samePhoneAsOtherAccount: true,
      sameParcelAsOtherAccount: true,
      sameCompanyNameAsOtherAccount: true,
      linkedToTrialCanceller: true,
    };
    const result = scoreFromFacts(everything);
    expect(result.score).toBe(100);
    expect(result.level).toBe("high");
    // The reasons are NOT capped: the score is what gets clamped, and support
    // still needs the full list to explain a refusal.
    expect(result.reasons.reduce((n, r) => n + r.points, 0)).toBeGreaterThan(100);
  });

  it("gives every reason a code, a positive weight, and a sentence", () => {
    const result = scoreFromFacts(
      facts({ cardSharedWithOtherAccount: true, disposableEmailDomain: true })
    );
    expect(result.reasons).toHaveLength(2);
    for (const reason of result.reasons) {
      expect(reason.code).toMatch(/^[a-z0-9_]+$/);
      expect(reason.points).toBeGreaterThan(0);
      expect(reason.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("scoreFromFacts: the hard-evidence invariant", () => {
  // THE STRUCTURAL GUARANTEE, not a tuning choice. Circumstantial evidence -
  // shared networks, shared hardware, shared houses, shared trade names, being
  // new - can pile as high as it likes and still stops one point short of the
  // top band. Reaching the top band requires a card link, or a neighbour who has
  // actually charged back or been flagged by a human.
  //
  // Every case below sums to well over HIGH_AT on raw points and must not get
  // there.
  const CIRCUMSTANTIAL: Array<[string, Partial<RiskFacts>]> = [
    [
      "a whole household in one afternoon",
      {
        accountsOnSameDevice: 4,
        accountsOnSameIpRecently: 3,
        sameParcelAsOtherAccount: true,
        accountAgeMinutes: 2,
        onboardingMinutesAfterSignup: 1,
        fingerprintAndIpMatch: true,
      },
    ],
    [
      "a device farm on a busy network with a throwaway inbox",
      {
        accountsOnSameDevice: 9,
        accountsOnSameIpRecently: 9,
        disposableEmailDomain: true,
        fingerprintAndIpMatch: true,
      },
    ],
    [
      "every network, fingerprint, parcel and account-age signal at once",
      {
        accountsOnSameIpRecently: 20,
        fingerprintAndIpMatch: true,
        sameParcelAsOtherAccount: true,
        accountAgeMinutes: 0,
        onboardingMinutesAfterSignup: 0,
      },
    ],
    [
      "everything circumstantial the table can produce",
      {
        accountsOnSameDevice: 50,
        accountsOnSameIpRecently: 50,
        fingerprintAndIpMatch: true,
        disposableEmailDomain: true,
        emailNormCollision: true,
        accountAgeMinutes: 0,
        onboardingMinutesAfterSignup: 0,
        samePhoneAsOtherAccount: true,
        sameParcelAsOtherAccount: true,
        sameCompanyNameAsOtherAccount: true,
        linkedToTrialCanceller: true,
      },
    ],
  ];

  it.each(CIRCUMSTANTIAL)("%s cannot reach high", (_label, overrides) => {
    const result = scoreFromFacts(facts(overrides));
    expect(result.score).toBeLessThan(HIGH_AT);
    expect(result.level).not.toBe("high");
  });

  it("says so in the reasons when it holds a score down", () => {
    const result = scoreFromFacts(
      facts({
        accountsOnSameDevice: 9,
        accountsOnSameIpRecently: 9,
        disposableEmailDomain: true,
        emailNormCollision: true,
      })
    );
    expect(result.score).toBe(HIGH_AT - 1);
    expect(result.reasons.map((r) => r.code)).toContain("capped_no_hard_evidence");
    // The reasons themselves are NOT trimmed: support still needs to see
    // everything that was observed, and that the cap is why it stopped there.
    expect(result.reasons.reduce((n, r) => n + r.points, 0)).toBeGreaterThan(
      HIGH_AT
    );
  });

  it("lets each of the three hard signals through", () => {
    // 20 + 20 + 25 = 65: capped at 69 without hard evidence, over the line with.
    const base = {
      accountsOnSameDevice: 4,
      accountsOnSameIpRecently: 3,
      disposableEmailDomain: true,
    };
    expect(scoreFromFacts(facts(base)).level).toBe("medium");

    for (const hard of [
      { cardSharedWithOtherAccount: true },
      { cardSharedWithUsedOrChargebackAccount: true },
      { sharesIpOrDeviceWithFlaggedAccount: true },
    ]) {
      expect(scoreFromFacts(facts({ ...base, ...hard })).level).toBe("high");
    }
  });

  it("does not mark a score that was already below the line", () => {
    const result = scoreFromFacts(facts({ accountsOnSameIpRecently: 3 }));
    expect(result.score).toBe(20);
    expect(result.reasons.map((r) => r.code)).not.toContain(
      "capped_no_hard_evidence"
    );
  });
});
