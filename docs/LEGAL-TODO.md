# Legal and compliance to-do (for Landen, to take to a CA attorney)

Written 2026-08-22 from a research pass over the repo's terms, pro terms,
privacy, AI disclosure and DMCA pages plus the 46 `TODO(legal)` markers in
`src`. A checklist, not legal advice. "Handled" means a page or mechanism
exists; "Open" means nothing exists yet.

## 1. Before launch (must)

1. **Form the entity.** No LLC exists. "Hearth LLC" is a placeholder in
   `src/app/terms/page.tsx` and `src/app/pro-terms/page.tsx`. File a CA LLC
   (bizfileonline.sos.ca.gov), get an EIN, file a county Fictitious Business
   Name statement if trading as "Hearth", get a Huntington Beach business
   license. No seller's permit needed (no tangible goods). Open.
2. **Register the DMCA agent** at dmca.copyright.gov and publish it in the
   Copyright Office directory; `src/app/dmca/page.tsx` is blank until then.
   Required for the safe harbor. Open.
3. **Fill every bracketed placeholder**: mailing address (`src/lib/notify.ts`,
   terms opt-out address, DMCA page), governing-law county, liability caps,
   contractor claims period, the "N months" anti-circumvention window in
   pro terms. Open. Also move the legal contact off Gmail.
4. **CSLB marketplace rules.** Keep the lead fee flat per lead, never a
   percentage of the job (a percentage can make the platform itself need a
   license). License numbers must appear in pro ads over $500 (B&P 7027.1,
   7048). Handled: "verified = point-in-time CSLB check" wording exists.
   Confirm fee structure with counsel.
5. **B.O.T. Act (B&P 17941)**: bot disclosure at the point of interaction.
   Mostly handled (in-chat AI label + /ai-disclosure); confirm the in-chat
   label alone satisfies "at the point of interaction".
6. **SMS: TCPA / CTIA / 10DLC.** Consent checkbox exists and is unchecked by
   default. Open: 10DLC brand + campaign registration, STOP auto-handling,
   quiet hours. Needed before any SMS goes to the public. (See William's
   list item 14 for the Twilio side.)
7. **CAN-SPAM**: every email needs a physical postal address and a working
   unsubscribe. Address is a `TODO(legal)` placeholder in `src/lib/notify.ts`.
   Open, blocks real email.
8. **18+**: handled (confirmation at signup).

## 2. Before charging money, or within 30 days of launch

9. **CA Automatic Renewal Law** (amended July 1, 2025, AB 2863): express
   affirmative consent to the renewal terms SEPARATE from general terms
   acceptance, annual reminder notices, one-step cancel, 3-year consent
   records; free-trial-to-paid conversions are covered. The checkout
   disclosure and in-app cancel exist; verify the separate consent and the
   annual reminder email. The federal FTC click-to-cancel rule was vacated in
   July 2025; CA's law still controls.
10. **CCPA/CPRA**: under the revenue/volume thresholds, but notice at
    collection and the privacy policy apply anyway and exist. Re-check the
    activity-based triggers (selling/sharing, sensitive PI) as features grow.
10b. **Trial-abuse risk score (migration 0130, `src/lib/risk`)**: Hearth now
    stores salted one-way hashes of device, network, browser-fingerprint,
    payment-method and normalized-email identifiers, used only to stop the same
    person farming the 3-day free trial with new accounts. Three things to
    confirm with counsel: (a) the CCPA notice at collection and the
    "Abuse-prevention identifiers" row in `src/lib/privacy.ts` CATEGORIES cover
    it, and the `/privacy` copy is accurate; (b) whether a hashed IP or device
    id counts as an identifier requiring anything beyond that notice under
    CPRA's "sharing" and ADMT rules (it is never sold, shared, or used for
    profiling, and it drives no automated decision other than declining a free
    trial and declining a sale); (c) whether the fraud-prevention exception
    (Cal. Civ. Code 1798.105(d)(2)) should be used to RETAIN abuse flags through
    an account deletion. Today it is not: the tables cascade on
    `auth.users` delete, so deleting an account wipes its signals and flags,
    which means account deletion is itself a way to reset the score. That is
    the privacy-friendly default and a real hole. Open decision.
11. **FTC Fake Reviews Rule (16 CFR Part 465)**: applies to the planned
    reviews feature and to showing Yelp/Google links. No fabricated or
    incentivized reviews; disclose insider reviews.
12. **Referral credits ($25/$25)**: disclose program terms in-app; FTC
    endorsement disclosure applies if pros promote it publicly.
13. **Sign in with Apple**: in-app account deletion must also revoke Apple
    tokens (Apple TN3194). Verify the delete-account flow does this.
14. **Insurance**: E&O and cyber liability quotes before real payments at
    scale.

## 3. Nice to have / monitor

15. **SB 942 (AI Transparency Act, Aug 2026)** and **AB 2013** target large
    GenAI developers; Hearth is a downstream API user, likely out of scope.
16. **SB 243 (companion chatbots, Jan 2026)**: Ask Hearth is task-based,
    likely excluded; confirm.
17. **Unruh Act / WCAG**: no federal mandate for private sites, but CA is the
    most litigated state ($4,000 per violation). A WCAG 2.1 AA pass is cheap
    insurance.
18. **CA SaaS sales tax**: not taxable today; SB 122 makes SaaS taxable from
    Jan 1, 2027. Plan 2027 pricing.
19. **Written data retention schedule** (the privacy page describes deletion;
    no internal document exists).

Files with `TODO(legal)` needing attorney sign-off: terms, pro-terms,
ai-disclosure, dmca pages; `src/lib/constants.ts`, `src/lib/notify.ts`,
`src/lib/privacy.ts`, `src/components/LegalContact.tsx`,
`src/app/(app)/account/ProfileInfoForm.tsx`,
`src/app/(auth)/recordTermsAcceptance.ts`.

Sources: CSLB online marketplace fast facts (cslb.ca.gov), leginfo B&P 7027.1
/ 7048 / 17941, Cooley on AB 2863, Sidley on the vacated FTC rule, FTC 16 CFR
465 final rule, Apple TN3194, CTIA messaging principles, Holland & Knight on
SB 122.
