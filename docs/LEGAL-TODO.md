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

## 4. 2026-08-26 update (privacy / AI-disclosure copy pass)

`/privacy`, `/ai-disclosure` and `src/lib/privacy.ts` were updated to reflect
five code changes: the Orange County-wide service area (36 cities,
`src/lib/serviceArea.ts`), the RentCast-AVM-or-formula home value estimate
(`src/lib/homeValue.ts`) and the new Photon/OpenStreetMap address-suggestion
third party (`src/lib/addressSuggest.ts`), a first-party cookie list
(`hearth_did`, `hearth_fp`, `hearth_pwrecovery`, the active-home cookie),
Twilio's 10-digit-US-numbers-only scope and STOP keyword, and the Orange-County gate
plus slur/contact-info moderation on public pro profiles
(`src/lib/publicText.ts`). No code changed as part of this pass, only the
legal-copy pages; still flagging for counsel:

20. **Re-flagging from item 2**: the DMCA agent is still unregistered and
    `src/app/dmca/page.tsx` is still blank. Open.
21. **Re-flagging from item 3**: the mailing/business address placeholders in
    `src/lib/notify.ts`, the terms opt-out address, and the DMCA page are
    still unfilled `TODO(legal)` markers. Open.
22. **Follow-up on 10b(a)**: the `/privacy` copy and the
    "Abuse-prevention identifiers" CCPA category now explicitly state that
    trial-abuse signals are retained only while the account exists, deleted
    with the account, and that a chargeback or manual flag can remove trial
    eligibility with the decision logged. Point (a) of 10b can likely be
    closed on review; points (b) and (c) of 10b (whether a hashed
    IP/device id needs more than notice under CPRA's sharing/ADMT rules, and
    whether to invoke the fraud-prevention retention exception) are still
    open decisions, unchanged by this copy pass.
23. **Orange County service-area expansion**: confirm the wider launch area
    (up from a handful of cities to all 36) doesn't trigger additional
    per-city business-license or marketplace-registration requirements beyond
    the Huntington Beach license already flagged in item 1.
24. **Public pro profile gating and moderation**: confirm the
    Orange-County-only visibility gate and the automated slur/profanity/
    contact-info filter on business name and About text
    (`src/lib/publicText.ts`, a keyword filter, not human review) is adequate
    disclosure and doesn't need its own consumer-facing moderation policy.

Files with `TODO(legal)` needing attorney sign-off: terms, pro-terms,
ai-disclosure, dmca pages; `src/lib/constants.ts`, `src/lib/notify.ts`,
`src/lib/privacy.ts`, `src/components/LegalContact.tsx`,
`src/app/(app)/account/ProfileInfoForm.tsx`,
`src/app/(auth)/recordTermsAcceptance.ts`.

## 5. 2026-08-30 update (privacy, terms, pro-terms, AI-disclosure copy pass)

`/privacy`, `/terms`, `/pro-terms` and `/ai-disclosure` were updated to reflect
the overnight 2026-08-29/30 wave (see STATUS.md, "Wave 2026-08-29/30"). No code
changed as part of this pass, only the legal-copy pages. What was added:

25. **Web push disclosure**: `/privacy`'s Notifications section now explains
    the push_subscriptions data collected (an endpoint and two keys, migration
    0143), that it is free and not gated by Hearth Plus, the allowlisted kinds
    it fires for, and the quiet-hours rule that holds weather/safety pushes
    between 9pm and 8am Pacific. Also added a glance-table row for it.
26. **SMS quiet hours**: `/privacy` now states texts are never sent between
    9pm and 8am Pacific, alongside a new TODO(legal) asking counsel to review
    the SMS consent checkbox wording on both the homeowner Account settings
    form and the pro sign-up form (`src/app/pro/onboarding/OnboardingCompanyForm.tsx`),
    and confirm STOP-handling and quiet-hours language meets TCPA/CTIA.
27. **Idle sign-out and log redaction**: `/privacy`'s cookie list now
    describes `hearth_seen` (35-day httpOnly stamp, 30-day idle sign-out) and
    `hearth_flash` (one-shot toast), plus a new paragraph listing the
    localStorage values Hearth keeps client-side (collapsed panels, the Ask
    Hearth daily lock, review-prompt timing, push-prompt snooze) and stating
    plainly that none of it leaves the device and no ad/analytics cookies are
    set. The Security section now also states the 30-day idle sign-out and
    that server logs are redacted before being written.
28. **Upload guard**: `/privacy`'s Photos and documents section now discloses
    that uploads are checked by their actual bytes (not the browser's claimed
    type), capped in size, and that photos have metadata (including GPS)
    stripped before storage.
29. **Owner-name publication (migration 0141)**: `/privacy`'s Public pro
    profiles section now discloses that a pro's own name, if they add one, is
    shown on their public profile page, with a new TODO(legal) asking counsel
    to confirm typing a name into a field a pro can see is public counts as
    adequate consent to publish it.
30. **Analytics retention gap found**: while writing this pass, found that
    `public.app_events` (migration 0093) is `on delete set null` on
    `user_id`, not `on delete cascade` like `push_subscriptions` (0143) and
    `pro_feedback` (0144) are. Deleting an account today unlinks usage-event
    rows rather than deleting them outright. `/privacy` now says this plainly
    and carries a new TODO(legal) asking whether that is acceptable retention
    practice given the rows carry no content beyond an id and a category.
    Related: item 19 above (no written retention schedule exists) and the new
    TODO(legal) added to `/privacy`'s "we keep each category of data..."
    paragraph, which now states the honest default (until account deletion or
    a request, aside from legally-required records) rather than implying a
    schedule that does not exist.
31. **Auto-renewal (California ARL, AB 2863, effective July 1, 2025)**:
    `/terms`'s Fees and refunds section now states the 3-day trial applies to
    every Hearth Plus and Hearth Pro plan and cadence
    (`src/lib/billingTerms.ts`, `PLUS_PLAN.trialDays` / `PRO_PLAN.trialDays`
    in `src/lib/constants.ts`), with a new TODO(legal) naming the amended
    statute and asking counsel to confirm the checkout flow actually collects
    a separate, itemized renewal consent rather than relying on this
    paragraph alone.
32. **Pro lead fees, ghost protection, and membership**: `/pro-terms` gained a
    new "Lead fees, wallet credit, and membership" section describing the
    flat per-category application fee, the ghost-protection wallet-credit
    refund, that deposits are non-refundable and bonus credit can expire, and
    that Hearth Pro membership is perks-only and never gates lead access
    (`LEAD_FEES`, `GHOST_PROTECTION_DAYS`, `BONUS_EXPIRY_DAYS`,
    `PRO_DEPOSIT_BOOST_PTS` in `src/lib/constants.ts`), flagged for attorney
    review.
33. **Feedback credit ($5, `src/lib/proFeedback.ts`)**: `/pro-terms` gained a
    new "Product feedback credit" section stating the credit is non-cash
    lead-application wallet credit, one claim per contractor account, gated
    on an established account, and explicitly never tied to a store rating or
    review, with a new TODO(legal) for the terms.
34. **Ask Hearth for Pros gating**: `/ai-disclosure` now discloses the daily
    cap difference between a free and a Hearth Pro contractor account, and
    that the copilot stays locked for a brand-new sign-up until the business
    looks established (verified license, a paid lead, a settled deposit, or
    membership) - a fraud control, described as such.
35. **Review-prompt no-incentives rule extended to store ratings**:
    `/terms`'s reviews paragraph now states explicitly that the
    no-payment-for-reviews rule also covers any in-app prompt asking someone
    to rate Hearth in the App Store or Play Store, matching the "NO
    INCENTIVES. EVER." block in `src/lib/reviewPrompt.ts`.

Files with `TODO(legal)` needing attorney sign-off, extended by this pass:
terms, pro-terms, privacy, ai-disclosure, dmca pages; `src/lib/constants.ts`,
`src/lib/notify.ts`, `src/lib/privacy.ts`, `src/components/LegalContact.tsx`,
`src/app/(app)/account/ProfileInfoForm.tsx`,
`src/app/(auth)/recordTermsAcceptance.ts`.

Sources: CSLB online marketplace fast facts (cslb.ca.gov), leginfo B&P 7027.1
/ 7048 / 17941, Cooley on AB 2863, Sidley on the vacated FTC rule, FTC 16 CFR
465 final rule, Apple TN3194, CTIA messaging principles, Holland & Knight on
SB 122.
