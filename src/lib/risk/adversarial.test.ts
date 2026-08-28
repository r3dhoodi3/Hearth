import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  scoreFromFacts,
  emptyFacts,
  HIGH_AT,
  MEDIUM_AT,
  type RiskFacts,
} from "./score";
import { attachDeviceCookie, DEVICE_COOKIE, FINGERPRINT_COOKIE } from "./cookies";

// ADVERSARIAL TESTS for the trial-abuse score (agent B, 2026-08-26; fixes and
// flipped assertions applied by agent A the same day).
//
// These began as CHARACTERIZATION tests: every one of them passed against the
// code as it stood, and every one of them described an outcome that was WRONG.
// The fix named in each block header has now been applied, and each assertion
// has been flipped to pin the FIXED behaviour instead. The original finding is
// left in the comment above it, in the past tense, because the reason a weight
// is where it is matters more than the number itself - and because the next
// person to tune this needs to know which cliffs are already marked.
//
// Two families of gap:
//   FALSE POSITIVE - an honest customer is punished (the expensive one).
//   BYPASS         - the farmer this whole system exists for walks straight
//                    through it.

function facts(overrides: Partial<RiskFacts> = {}): RiskFacts {
  return { ...emptyFacts(), ...overrides };
}

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const factsSrc = src("./facts.ts");
const signalsSrc = src("./signals.ts");
const scoreSrc = src("./score.ts");
const decisionSrc = src("./decision.ts");
const cookiesSrc = src("./cookies.ts");
const plusAction = src("../../app/(app)/plus/actions.ts");
const proAction = src("../../app/pro/plus/actions.ts");
const plusPage = src("../../app/(app)/plus/page.tsx");
const proPage = src("../../app/pro/plus/page.tsx");
const webhook = src("../../app/api/stripe/webhook/route.ts");
const fingerprintComponent = src("../../components/DeviceFingerprint.tsx");
const migration = src("../../../supabase/migrations/0130_account_risk.sql");

// ===========================================================================
// FALSE POSITIVE 1 - the second person in one household.
// ===========================================================================
// Two adults, one home, one iPad, one wifi. The second one signs up, claims the
// same house through the normal onboarding flow (which takes about a minute),
// and tries to buy Plus in the same sitting. Nothing about this is abuse; it is
// the flow the product asks people to follow.
//
// WAS: 75 points, over the refuse-the-sale line, and 25 of those 75 described a
// single behaviour (they did it all at once) charged twice. Thirty seconds of
// hesitation over the onboarding form was the entire difference between two
// outcomes.
//
// FIXED, four ways: household co-members are subtracted from the parcel and
// device links in facts.ts before either is scored; sameParcel dropped 20 -> 10;
// the account-age band and the fast-onboarding bonus are now exclusive (the
// larger wins); and no purely circumstantial pile can reach the top band at all.
describe("FIXED: a spouse on the family iPad", () => {
  const spouse = facts({
    accountsOnSameDevice: 2, // the household iPad
    accountsOnSameIpRecently: 2, // the household wifi
    sameParcelAsOtherAccount: true, // the household house
    accountAgeMinutes: 3, // signed up and bought in one sitting
    onboardingMinutesAfterSignup: 1.5, // the onboarding flow really is this fast
  });

  it("scores 55, comfortably below the top band", () => {
    expect(scoreFromFacts(spouse).score).toBe(55);
    expect(scoreFromFacts(spouse).score).toBeLessThan(HIGH_AT);
  });

  it("lands in medium, which costs the free trial and nothing else", () => {
    expect(scoreFromFacts(spouse).level).toBe("medium");
  });

  it("charges 'did it in one sitting' exactly once", () => {
    const codes = scoreFromFacts(spouse).reasons.map((r) => r.code);
    expect(codes).toContain("account_minutes_old"); // 15
    expect(codes).not.toContain("instant_onboarding"); // no longer added on top
  });

  it("no longer turns 30 seconds of hesitation into a different outcome", () => {
    const slower = { ...spouse, onboardingMinutesAfterSignup: 2.5 };
    expect(scoreFromFacts(slower).score).toBe(scoreFromFacts(spouse).score);
    expect(scoreFromFacts(slower).level).toBe("medium");
  });

  it("subtracts household co-members from the parcel and device links", () => {
    expect(factsSrc).toContain("async function householdPeerIds(");
    expect(factsSrc).toContain("household_members");
    expect(factsSrc).toContain(
      "facts.sameParcelAsOtherAccount = withoutHousehold(linkedOf(\"parcel\")).size > 0"
    );
    expect(factsSrc).toContain(
      "const deviceLinked = withoutHousehold(linkedOf(\"device\"))"
    );
  });

  it("even a whole household in one afternoon cannot reach the top band", () => {
    const bigHousehold = facts({
      accountsOnSameDevice: 4,
      accountsOnSameIpRecently: 4,
      sameParcelAsOtherAccount: true,
      samePhoneAsOtherAccount: true,
      accountAgeMinutes: 1,
      onboardingMinutesAfterSignup: 0.5,
      fingerprintAndIpMatch: true,
    });
    expect(scoreFromFacts(bigHousehold).level).not.toBe("high");
  });
});

// ===========================================================================
// FALSE POSITIVE 2 - one real-world event scored twice.
// ===========================================================================
// A single honest cancellation inside a free trial writes ONE abuse_flags row
// of kind 'trial_abuse'. facts.ts used to read that one row into TWO separate
// facts: sharesIpOrDeviceWithFlaggedAccount (40) and linkedToTrialCanceller
// (25). 65 points, from one person deciding Hearth was not for them.
//
// FIXED: 'trial_abuse' no longer feeds the +40 flagged-neighbour weight at all
// (only 'chargeback' and hand-written 'manual' flags do), and
// linkedToTrialCanceller is computed only over STRONG link kinds.
describe("FIXED: one cancelled trial next door", () => {
  it("is worth 25 points, once", () => {
    const neighbour = facts({ linkedToTrialCanceller: true });
    expect(scoreFromFacts(neighbour).score).toBe(25);
    expect(scoreFromFacts(neighbour).level).toBe("low");
  });

  it("cannot produce the flagged-neighbour weight any more", () => {
    // The +40 set is built from chargeback and manual flags only.
    expect(factsSrc).toContain(
      '.filter((f) => f.kind === "chargeback" || f.kind === "manual")'
    );
    expect(factsSrc).not.toContain(
      "const flaggedIds = new Set(flags.map((f) => f.user_id))"
    );
  });

  it("counts only through a strong link, never a shared network", () => {
    expect(factsSrc).toContain(
      'const STRONG_LINKS: SignalKind[] = ["card", "device", "email_norm", "phone"]'
    );
    expect(factsSrc).toContain("facts.linkedToTrialCanceller = Array.from(stronglyLinked)");
  });

  it("plus a household device signal is still only medium", () => {
    const spouseOfSomeoneWhoCancelled = facts({
      linkedToTrialCanceller: true,
      accountsOnSameDevice: 2,
    });
    expect(scoreFromFacts(spouseOfSomeoneWhoCancelled).score).toBe(45);
    expect(scoreFromFacts(spouseOfSomeoneWhoCancelled).level).toBe("medium");
  });
});

// ===========================================================================
// FALSE POSITIVE 3 - carrier NAT.
// ===========================================================================
// A phone on T-Mobile or Verizon shares one egress IP with thousands of other
// subscribers. Three Hearth accounts behind that IP inside a week is not a
// coincidence to be explained, it is Tuesday.
//
// WAS: the link RPC had no time filter at all, so a DHCP address recycled a year
// ago linked two strangers forever, and once ONE of those thousands had been
// flagged, every other customer on that carrier carried 65 points before doing
// anything.
//
// FIXED: linked_accounts windows 'ip' links to 7 days on BOTH sides of the join
// (matching the window the IP count already used), and the trial-cancel flag no
// longer travels over a network link at all.
describe("FIXED: a mobile customer behind carrier NAT", () => {
  it("stays in medium on network evidence alone", () => {
    const onCarrierNat = facts({
      accountsOnSameIpRecently: 3,
      linkedToTrialCanceller: true,
    });
    expect(scoreFromFacts(onCarrierNat).score).toBe(45);
    expect(scoreFromFacts(onCarrierNat).level).toBe("medium");
  });

  it("cannot reach the top band no matter how busy the network is", () => {
    const wholeCarrier = facts({
      accountsOnSameIpRecently: 500,
      fingerprintAndIpMatch: true,
      linkedToTrialCanceller: true,
      accountAgeMinutes: 0,
    });
    expect(scoreFromFacts(wholeCarrier).level).not.toBe("high");
  });

  it("the link RPC now windows IP links to 7 days, on both sides", () => {
    const body = migration.slice(migration.indexOf("create or replace function"));
    expect(body).toContain("other.value_hash = mine.value_hash");
    expect(body).toContain("other.last_seen > now() - interval '7 days'");
    expect(body).toContain("mine.last_seen > now() - interval '7 days'");
  });

  it("leaves every other kind of link unwindowed, which is correct", () => {
    // A card, a device cookie, a phone number and a parcel mean the same thing
    // a year later. Only an IP address stops meaning anything.
    const body = migration.slice(migration.indexOf("create or replace function"));
    expect(body).toContain("other.kind <> 'ip' or");
  });
});

// ===========================================================================
// FALSE POSITIVE 4 - the fingerprint is not a device.
// ===========================================================================
// DeviceFingerprint.tsx hashes user agent + screen size + timezone offset +
// language + core count. In one metro area, on one popular phone, that is the
// SAME hash for every customer: Safari freezes the iOS user agent, the screen
// size is the model, the timezone is the county and the language is en-US.
//
// WAS: facts.ts unioned those fingerprint links into the DEVICE set, so a coarse
// cohort was counted as "accounts on this device" and five strangers on the same
// phone model read as a five-account device farm.
//
// FIXED: the fingerprint has its own weight of 10, counts only when the same
// account also matches on IP, and is kept out of the device count and the
// flagged-neighbour check entirely.
describe("FIXED: a common phone model is no longer a device farm", () => {
  it("still collects only coarse, cohort-wide attributes", () => {
    expect(fingerprintComponent).toContain("navigator.userAgent");
    expect(fingerprintComponent).toContain("screen.width");
    expect(fingerprintComponent).toContain("getTimezoneOffset");
    expect(fingerprintComponent).toContain("navigator.language");
    expect(fingerprintComponent).toContain("hardwareConcurrency");
    // No canvas, no WebGL, no audio, no fonts - so nothing that would actually
    // separate two identical iPhones. That is exactly why it is worth 10.
  });

  it("is no longer folded into the device count", () => {
    expect(factsSrc).not.toContain('...linkedOf("fingerprint"),');
    expect(factsSrc).toContain(
      "const deviceLinked = withoutHousehold(linkedOf(\"device\"))"
    );
    expect(factsSrc).toContain("facts.accountsOnSameDevice = deviceLinked.size + 1");
  });

  it("counts only alongside an IP match, and only for 10", () => {
    expect(factsSrc).toContain("facts.fingerprintAndIpMatch = Array.from(fingerprintLinked).some");
    expect(scoreFromFacts(facts({ fingerprintAndIpMatch: true })).score).toBe(10);
  });

  it("a cohort of strangers on one phone model scores 10, not 40", () => {
    // The whole cohort now produces one small corroborating signal instead of a
    // device-farm reading.
    const sameModelCohort = facts({
      fingerprintAndIpMatch: true,
      accountsOnSameDevice: 1,
    });
    expect(scoreFromFacts(sameModelCohort).score).toBe(10);
    expect(scoreFromFacts(sameModelCohort).level).toBe("low");
  });

  it("never lets a fingerprint link reach the flagged-neighbour weight", () => {
    // The +40 is computed over IP links and the httpOnly device cookie only.
    expect(factsSrc).toContain(
      "new Set([...linkedOf(\"ip\"), ...deviceLinked])\n    ).some((id) => flaggedIds.has(id))"
    );
  });
});

// ===========================================================================
// BYPASS 1 - the fingerprint cookie is attacker-controlled.
// ===========================================================================
// hearth_fp is written by page script with document.cookie and no HttpOnly, so
// the browser owns it.
//
// WAS: an attacker who can compute a VICTIM's fingerprint (five attributes their
// own site can read from any visitor) could set hearth_fp to that value, farm
// and burn a few accounts under it, and leave the victim sharing a "device" with
// a flagged account - a permanent 85-point mark for the price of one link click.
//
// FIXED: the fingerprint is hashed BOUND TO the httpOnly device cookie
// (hash(did || fp)), so a forged value can only ever collide with something
// under the forger's own device cookie. The victim is unreachable. It is also
// skipped entirely when there is no device cookie to bind it to.
describe("FIXED: hearth_fp can no longer be pointed at a stranger", () => {
  it("is still set from page script with no HttpOnly flag", () => {
    // Unchanged, and fine: the script that computes it is the thing that writes
    // it, so hiding it from that script would protect nothing.
    expect(fingerprintComponent).toContain("document.cookie =");
    expect(fingerprintComponent).not.toMatch(/HttpOnly/i);
  });

  it("is bound to the httpOnly device cookie before it is hashed", () => {
    expect(signalsSrc).toContain("c.get(FINGERPRINT_COOKIE)?.value");
    expect(signalsSrc).toContain("const boundFingerprint =");
    expect(signalsSrc).toContain("device && fingerprint");
    expect(signalsSrc).toContain(
      'recordSignal(userId, "fingerprint", boundFingerprint, context)'
    );
    // The raw client value is never stored on its own any more.
    expect(signalsSrc).not.toContain(
      'recordSignal(userId, "fingerprint", fingerprint, context)'
    );
  });

  it("keeps the two cookies' trust properties separate in the scoring", () => {
    expect(cookiesSrc).toContain("httpOnly: true"); // hearth_did
    expect(FINGERPRINT_COOKIE).toBe("hearth_fp");
    expect(DEVICE_COOKIE).toBe("hearth_did");
    // The device count is the httpOnly cookie alone; the fingerprint has its own
    // much smaller, IP-corroborated weight.
    expect(factsSrc).toContain("const fingerprintLinked = linkedOf(\"fingerprint\")");
  });
});

// ===========================================================================
// BYPASS 2 - the card, the 60-point signal, never fired when it mattered.
// ===========================================================================
// The card fingerprint is only ever learned from Stripe, in the webhook, AFTER
// checkout.session.completed. The trial decision is taken before the session is
// created. So on the FIRST checkout of any account - the only checkout that can
// hand out a free trial - the card is necessarily unknown.
//
// WAS: nothing ever revisited that. A farmer with a fresh email, a cleared
// cookie jar and a phone hotspot got trial after trial on the same physical
// card, and the strongest weight in the table did nothing at all.
//
// FIXED: the webhook re-runs the score the moment the card is recorded, and if
// the subscription is still trialing and the score is medium or high, it ends
// the trial (trial_end: "now") and tells the buyer their billing starts today.
// Same outcome medium produces at checkout, applied three seconds later instead
// of never.
describe("FIXED: the card signal now reaches a decision", () => {
  it("is still only learned in the webhook, which is unavoidable", () => {
    expect(webhook).toContain("recordCardSignal");
    expect(plusAction).not.toContain("recordCardSignal");
    expect(proAction).not.toContain("recordCardSignal");
  });

  it("is written on both checkout branches and on paid invoices", () => {
    expect(webhook).toContain(
      'recordSubscriptionCard(meta.user_id, subscription, "pro_checkout")'
    );
    expect(webhook).toContain(
      'recordSubscriptionCard(meta.user_id, subscription, "plus_checkout")'
    );
    expect(webhook).toContain('"invoice_paid"');
  });

  it("re-runs the score once the card is known", () => {
    expect(webhook).toContain("computeRisk(");
    expect(webhook).toContain("async function endTrialIfRisky(");
    // Called on BOTH sides, after the acknowledgment, so a corrected buyer reads
    // the correction second.
    expect(webhook.match(/await endTrialIfRisky\(/g)?.length).toBe(2);
  });

  it("ends the trial immediately when the card links to somebody", () => {
    expect(webhook).toContain(
      'stripe.subscriptions.update(subscription.id, { trial_end: "now" })'
    );
  });

  it("tells the buyer, in the same words the checkout would have used", () => {
    // Silently converting a promised free trial into a charge would be the one
    // genuinely indefensible thing this system could do.
    expect(webhook).toContain("membership starts today");
    expect(webhook).toContain("billingTermsText(plan, false)");
    expect(webhook).toContain("sendNotification(");
  });

  it("cannot double-process a redelivered event", () => {
    expect(webhook).toContain("async function claimRiskEvent(");
    expect(webhook).toContain("processed_stripe_events");
    // Namespaced so it can never collide with the money paths' own claims.
    expect(webhook).toContain("`risk:${eventId}`");
  });

  it("does nothing while the log-only switch is off", () => {
    expect(webhook).toContain("riskEnforcementEnabled()");
    expect(webhook).toContain("would end trial (log-only mode)");
  });

  it("the checkout-time score for that farmer is still zero, honestly", () => {
    // Nothing here is fixed by pretending otherwise: at decision time the card
    // genuinely is not knowable. The fix is the webhook above, not the score.
    const secondTrial = facts({
      cardSharedWithUsedOrChargebackAccount: false,
      accountAgeMinutes: 240,
    });
    expect(scoreFromFacts(secondTrial).score).toBe(0);
    expect(scoreFromFacts(secondTrial).level).toBe("low");
  });

  it("and the score the webhook then computes takes the trial away", () => {
    const ifWeKnow = facts({ cardSharedWithUsedOrChargebackAccount: true });
    expect(scoreFromFacts(ifWeKnow).score).toBe(60);
    expect(scoreFromFacts(ifWeKnow).level).toBe("medium"); // no trial - correct
  });
});

// ===========================================================================
// BYPASS 3 - the weights did not do what the file said they did.
// ===========================================================================
// score.ts used to claim, in its own tuning notes: "A single shared card, a
// single shared IP, or a single disposable inbox all land in `medium`". None of
// the three did. cardSharedWithOther was 35, MEDIUM_AT is 40, so the single most
// useful thing this system can learn - "this card is already on another Hearth
// account" - changed nothing.
//
// FIXED: cardSharedWithOther raised to 40, exactly the medium edge, so a shared
// card always at least costs the trial. The prose was rewritten to match the
// numbers, and the two lesser claims were dropped rather than made true: a lone
// shared IP and a lone disposable inbox SHOULD stay in low.
describe("FIXED: a shared card now costs the free trial", () => {
  it("scores 40, exactly the medium edge", () => {
    const result = scoreFromFacts(facts({ cardSharedWithOtherAccount: true }));
    expect(result.score).toBe(40);
    expect(result.score).toBe(MEDIUM_AT);
    expect(result.level).toBe("medium"); // -> allowTrial false. No free days.
  });

  it("deliberately leaves a lone network or inbox signal in low", () => {
    // These two are weak on purpose. A shared IP is carrier NAT; a throwaway
    // inbox is 25 points of suspicion, not a verdict.
    expect(scoreFromFacts(facts({ accountsOnSameIpRecently: 9 })).level).toBe("low");
    expect(scoreFromFacts(facts({ disposableEmailDomain: true })).level).toBe("low");
  });

  it("score.ts prose now agrees with its own numbers", () => {
    expect(scoreSrc).toContain("40 is exactly");
    expect(scoreSrc).toContain("MEDIUM_AT");
    expect(scoreSrc).not.toContain(
      "single shared card, a single shared IP, or a single disposable inbox all"
    );
  });
});

// ===========================================================================
// BYPASS 4 - the two surfaces could disagree about the same checkout.
// ===========================================================================
// The /plus pages compute the decision with persist:false and record NOTHING.
//
// WAS: the checkout actions called recordRequestSignals FIRST and then decided,
// so a buyer who signed up on their phone and bought on the household iPad saw
// "free for 3 days" on the page and was charged today by the action - which had
// just written the device signal the page never saw. The auto-renewal disclosure
// they consented to was the wrong one, in the direction ROSCA and California's
// ARL care about.
//
// FIXED: decide first, record afterwards, in both actions.
describe("FIXED: page copy and Stripe agree on the same render", () => {
  it("the actions decide BEFORE they record", () => {
    for (const source of [plusAction, proAction]) {
      const recordAt = source.indexOf("await recordRequestSignals(");
      const decideAt = source.indexOf("await trialDecision(");
      expect(recordAt).toBeGreaterThan(-1);
      expect(decideAt).toBeGreaterThan(-1);
      expect(decideAt).toBeLessThan(recordAt);
    }
  });

  it("the signals are still recorded, for the NEXT checkout", () => {
    expect(plusAction).toContain('recordRequestSignals(user.id, "plus_checkout")');
    expect(proAction).toContain('recordRequestSignals(user.id, "pro_checkout")');
  });

  it("the pages record nothing at all before deciding", () => {
    for (const source of [plusPage, proPage]) {
      expect(source).toContain("await trialDecision(");
      expect(source).toContain("persist: false");
      expect(source).not.toContain("recordRequestSignals");
    }
  });

  it("the page's decision is the one the disclosure copy is built from", () => {
    // The homeowner page now fails CLOSED through isPlusTrialEligible (red team 2).
    expect(plusPage).toMatch(
      /const trialEligible =\s*\(await isPlusTrialEligible\(\)\) && \(risk\?\.allowTrial \?\? true\)/
    );
    expect(proPage).toContain("const trialEligible = !sub && (risk?.allowTrial ?? true)");
  });
});

// ===========================================================================
// BYPASS 5 / FALSE POSITIVE 5 - "cancelled during the trial" is not abuse.
// ===========================================================================
// WAS: the webhook wrote a sticky trial_abuse flag whenever a subscription
// reached `canceled` while our stored status was still `trialing`. That is
// exactly what the product TELLS people to do ("cancelling before then costs
// nothing"), so every honest three-day tyre-kicker was permanently marked - and
// it also fired when a card expired and Stripe cancelled rather than leaving the
// subscription past_due.
//
// FIXED, twice over: the flag now requires corroboration (the account has to
// score above `low` for some other reason before it is written at all), and even
// when written it no longer feeds the +40 flagged-neighbour weight.
describe("FIXED: an honest 'not for me' is not a permanent abuse flag", () => {
  it("still recognises the cancel-inside-trial shape", () => {
    expect(webhook).toContain("const cancelledInTrial =");
    expect(webhook).toContain('status === "canceled" &&');
    expect(webhook).toContain('existing?.status === "trialing"');
  });

  it("requires a corroborating signal before writing the flag", () => {
    expect(webhook).toContain("if (cancelledInTrial && existing?.user_id)");
    expect(webhook).toContain('computeRisk(existing.user_id, {');
    expect(webhook).toContain('if (level === "low")');
    expect(webhook).toContain(
      "trial cancelled with no corroborating signal, not flagging"
    );
  });

  it("still writes the flag when the account looked like a farm anyway", () => {
    expect(webhook).toMatch(/flagAbuse\(\s*\n?\s*existing\.user_id,\s*\n?\s*"trial_abuse"/);
  });

  it("the flag no longer feeds the flagged-neighbour weight", () => {
    expect(factsSrc).toContain(
      '.filter((f) => f.kind === "chargeback" || f.kind === "manual")'
    );
  });

  it("the product still literally invites the behaviour, which is the point", () => {
    expect(proAction).toContain("cancelling before then costs nothing");
  });
});

// ===========================================================================
// MIDDLEWARE - the device cookie rode on responses that should stay cacheable.
// ===========================================================================
// WAS: attachDeviceCookie skipped /api/ and /_next/ only, so everything else the
// matcher lets through got a Set-Cookie, including the routes crawlers hammer:
// /robots.txt, /sitemap.xml, /manifest.webmanifest, /opengraph-image. That tells
// the CDN not to cache them and plants a 400-day cookie in every bot.
//
// FIXED: any path with a file extension is skipped, the well-known metadata
// routes are skipped by prefix, and the whole body is wrapped in try/catch.
describe("FIXED: the device cookie only lands on pages people read", () => {
  function fakeRequest(pathname: string, hasCookie = false) {
    return {
      nextUrl: { pathname },
      cookies: {
        get: (name: string) =>
          hasCookie && name === DEVICE_COOKIE ? { value: "existing" } : undefined,
      },
    } as any;
  }

  function fakeResponse() {
    const set: Array<{ name: string; value: string }> = [];
    return {
      set,
      cookies: {
        set: (name: string, value: string) => set.push({ name, value }),
      },
    } as any;
  }

  it("skips /api and /_next, as it always did", () => {
    for (const path of ["/api/stripe/webhook", "/_next/static/chunk.js"]) {
      const res = fakeResponse();
      attachDeviceCookie(fakeRequest(path), res);
      expect(res.set).toHaveLength(0);
    }
  });

  it("now skips robots.txt, sitemap.xml, the manifest and the OG image", () => {
    for (const path of [
      "/robots.txt",
      "/sitemap.xml",
      "/manifest.webmanifest",
      "/opengraph-image",
      "/opengraph-image-a1b2c3",
      "/apple-icon",
      "/favicon.ico",
      "/icon-192.png",
    ]) {
      const res = fakeResponse();
      attachDeviceCookie(fakeRequest(path), res);
      expect(res.set).toHaveLength(0);
    }
  });

  it("still plants it on a funnel page, which is the whole point", () => {
    for (const path of [
      "/plus",
      "/signin",
      "/pro/plus",
      "/get-started",
      "/homeowner-signup",
      "/contractor-signup",
      "/welcome",
      "/welcome/role",
      "/onboarding",
      "/pro/onboarding",
    ]) {
      const res = fakeResponse();
      attachDeviceCookie(fakeRequest(path), res);
      expect(res.set.map((c: { name: string }) => c.name)).toEqual([DEVICE_COOKIE]);
    }
  });

  it("leaves the marketing site alone: only the signup and payment funnel is cookied", () => {
    // The score only ever asks whether several accounts were created or paid
    // for from one browser. A reader who never enters the funnel has nothing
    // to link, so a Set-Cookie on these pages bought nothing and cost the CDN
    // a cacheable response. "/plush" is here because a bare startsWith on the
    // "/plus" entry would wrongly claim it.
    for (const path of [
      "/",
      "/pros",
      "/guides/water-heater",
      "/p/some-contractor",
      "/privacy",
      "/terms",
      "/plush",
    ]) {
      const res = fakeResponse();
      attachDeviceCookie(fakeRequest(path), res);
      expect(res.set).toHaveLength(0);
    }
  });

  it("leaves an existing cookie alone", () => {
    const res = fakeResponse();
    attachDeviceCookie(fakeRequest("/plus", true), res);
    expect(res.set).toHaveLength(0);
  });

  it("returns the untouched response rather than throwing", () => {
    // Middleware runs on every route in the matcher. A throw here is not a lost
    // signal, it is the whole site down.
    const fn = cookiesSrc.slice(cookiesSrc.indexOf("export function attachDeviceCookie"));
    expect(fn).toContain("crypto.randomUUID()");
    expect(fn).toContain("try {");
    expect(fn).toContain("} catch {");

    const broken = {
      get nextUrl(): never {
        throw new Error("boom");
      },
    } as any;
    const res = fakeResponse();
    expect(() => attachDeviceCookie(broken, res)).not.toThrow();
    expect(res.set).toHaveLength(0);
  });
});

// ===========================================================================
// SALT - a rotation of the service-role key silently reset the whole system.
// ===========================================================================
// WAS: the fallback salt was the first 32 characters of
// SUPABASE_SERVICE_ROLE_KEY. Rotating that key is a routine security response,
// and doing it would have changed every hash this module produces: every stored
// signal stops matching, every repeat offender reads as brand new, and NOTHING
// logged it.
//
// FIXED: the fallback is gone. A missing RISK_HASH_SALT means riskHash returns
// null, no signals are recorded, an error is logged at module load and again on
// first use, and the decision fails open. A salt_version column now makes a
// future rotation a migration rather than amnesia.
describe("FIXED: the salt is a hard requirement, loudly", () => {
  it("has no service-role-key fallback at all", () => {
    const hashSrc = src("./hash.ts");
    expect(hashSrc).not.toContain("serviceKey.slice(0, 32)");
    // The name survives in ONE comment, explaining why the fallback was
    // removed. It must not appear in any executable line.
    const code = hashSrc
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("logs when it is missing, in the salt function itself", () => {
    const hashSrc = src("./hash.ts");
    const fn = hashSrc.slice(
      hashSrc.indexOf("function riskSalt()"),
      hashSrc.indexOf("export function riskSaltIsConfigured")
    );
    expect(fn).toContain("console.error");
    expect(fn).toContain("RISK_HASH_SALT");
  });

  it("records NOTHING rather than hashing under a repo constant", () => {
    expect(signalsSrc).toContain("const valueHash = riskHash(kind, normalized)");
    expect(signalsSrc).toContain("if (!valueHash) return;");
  });

  it("checks the salt at module load, where an operator will see it", () => {
    expect(factsSrc).toContain("riskSaltIsConfigured()");
    expect(factsSrc).toContain("RISK_HASH_SALT is not configured");
  });

  it("stamps a salt version on every row it writes", () => {
    expect(signalsSrc).toContain("salt_version: SALT_VERSION");
    expect(migration).toContain("salt_version smallint not null default 1");
  });

  it("logs its read failures instead of swallowing them", () => {
    // A live database that never ran 0130 used to produce a score of 0 for
    // everybody, forever, with no trace in the logs.
    expect(factsSrc).toContain("function readRows(");
    expect(factsSrc).toContain("read failed:");
    expect(factsSrc).toContain("read threw:");
    expect(factsSrc).not.toContain("(r: any) => (r.error ? [] : (r.data ?? []))");
  });
});

// ===========================================================================
// THE DECISION TABLE - what any of this actually does to somebody.
// ===========================================================================
// Added with the fixes. The score got a lot of attention; what it is allowed to
// DO got less, and that is the part that can cost a real sale.
describe("the decision table", () => {
  it("never refuses a sale off the score alone", () => {
    // allowCheckout is unconditionally true on the scored path. The only route
    // to a refusal is a hand-written 'manual' abuse flag.
    expect(decisionSrc).toContain("// The score never refuses a sale.");
    expect(decisionSrc).toContain("if (manualBlock)");
    expect(decisionSrc).toContain("allowCheckout: false");
  });

  it("treats the top band as a logging event", () => {
    // Whitespace-tolerant on purpose. What this pins is that the high band is
    // logged with console.error, not the indentation of the call - that broke
    // once already when trialDecision's body was lifted out of a try block
    // (the render-path decision cache), which dedented these lines by two
    // columns without changing a thing about what they do.
    expect(decisionSrc).toMatch(/console\.error\(\s*"\[risk\] high"/);
  });

  it("ships in log-only mode by default", () => {
    expect(decisionSrc).toContain("export function riskEnforcementEnabled()");
    expect(decisionSrc).toContain('=== "true"');
    expect(decisionSrc).toContain("if (!riskEnforcementEnabled())");
  });

  it("checks the manual override before it computes anything", () => {
    const decideAt = decisionSrc.indexOf("loadEnforcementState(userId)");
    const computeAt = decisionSrc.indexOf("await computeRisk(");
    expect(decideAt).toBeGreaterThan(-1);
    expect(computeAt).toBeGreaterThan(decideAt);
  });
});

// ===========================================================================
// WHAT DOES HOLD UP. Pinned so a later change cannot quietly undo it.
// ===========================================================================
describe("what the score gets right", () => {
  it("excludes the account itself from its own links", () => {
    expect(migration).toContain("other.user_id <> mine.user_id");
    // A dual-side account (homeowner and pro on one user id) therefore cannot
    // link to itself on any signal.
  });

  it("counts device and network inclusively and consistently", () => {
    expect(emptyFacts().accountsOnSameDevice).toBe(1);
    expect(emptyFacts().accountsOnSameIpRecently).toBe(1);
    expect(scoreFromFacts(emptyFacts()).score).toBe(0);
    expect(factsSrc).toContain("recent.add(userId); // the count includes this account");
  });

  it("keeps a lone shared card out of the top band", () => {
    // A couple paying for both memberships on one card must still be able to buy.
    expect(scoreFromFacts(facts({ cardSharedWithOtherAccount: true })).level).not.toBe(
      "high"
    );
    expect(scoreFromFacts(facts({ cardSharedWithUsedOrChargebackAccount: true })).level).toBe(
      "medium"
    );
  });

  it("fails open: the empty facts an error degrades to allow everything", () => {
    expect(scoreFromFacts(emptyFacts()).level).toBe("low");
    expect(decisionSrc).toContain("allowTrial: true");
    expect(decisionSrc).toContain("allowCheckout: true");
    expect(decisionSrc).toContain("return ALLOW_ALL;");
  });
});
