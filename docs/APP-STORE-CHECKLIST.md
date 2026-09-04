# App Store approval checklist for a future OakTend iOS app

Researched 2026-08-19 against Apple's live App Review Guidelines
(https://developer.apple.com/app-store/review/guidelines/). OakTend has no iOS app yet; this is
the list of things App Review will actually check for a two-sided home-services marketplace, so
nothing here is a surprise the week of submission. Companion doc: APPLE-SIGN-IN-SETUP.md (the
web-side Apple login setup, whose Apple Developer artifacts an iOS build reuses).

## 1. Login services (Guideline 4.8) - BLOCKING, already solved on web

Because OakTend offers Google sign-in, the iOS app must also offer a privacy-focused equivalent:
one that limits data collection to name and email, lets users keep their email private, and does
not collect app interactions for advertising without consent. Sign in with Apple satisfies this
and is what reviewers expect in practice (since the 2022 rewrite, Apple's own service is no
longer named as the ONLY acceptable answer, but it is the safe one). The web app already ships
the Apple button; the iOS build inherits the same Supabase provider. Note: the iOS bundle ID must
be appended to the Supabase Apple provider's Client IDs list (web Services ID stays first).

## 2. Account deletion in-app (Guideline 5.1.1(v)) - BLOCKING, mostly solved

Apps that support account creation must offer account DELETION inside the app - findable, not a
link to a website form with extra steps, and a real deletion, not deactivation. OakTend already
has account deletion; the iOS build must expose it in its own UI. Reference:
https://developer.apple.com/support/offering-account-deletion-in-your-app/

## 3. Payments: Stripe is REQUIRED, not just allowed (Guideline 3.1.3(e))

For physical goods and services consumed OUTSIDE the app, Apple's rule is that you MUST use
purchase methods other than in-app purchase. Homeowner payments and contractor lead fees for
real-world home services fall squarely here - Stripe stays, IAP is not wanted. (Older articles
cite this as 3.1.5(a); it now lives at 3.1.3(e). Current 3.1.5 is Cryptocurrencies.)

One gray area to manage deliberately: the PRO MEMBERSHIP subscription. As long as its value is
access to real-world work (leads, job matching, service demand), it follows the same rule and
comparable apps (Thumbtack, Angi) bill it outside IAP. But if membership ever unlocks purely
digital in-app perks (analytics dashboards, boosted placement), Apple could demand IAP for that
piece. Safest structure for the iOS app: do not sell or upsell the membership inside the app at
all - sell it on the web, have the app honor the entitlement. Since May 2025 (the Epic
injunction), US-storefront apps may also link out to external purchase pages without commission.

## 4. Minimum functionality (Guideline 4.2) - the web-wrapper rejection

A bare WebView/Capacitor wrapper of the website gets rejected; Apple says push notifications or
location alone are not enough to fix that. What passes: native-feeling navigation (tab bar),
push notifications that matter (new lead alerts for pros, application updates for homeowners),
offline/degraded-network handling, camera and photo-library integration (a natural fit: job
photos, photo-to-AI diagnosis), biometric login, iOS-adapted UI. Capacitor itself is fine as the
shell; the experience must feel adapted to iOS, not a bookmark.

## 5. Privacy nutrition labels + ATT

- App Privacy details in App Store Connect must accurately cover everything collected, including
  what third-party SDKs collect (Supabase, Stripe, any analytics, the AI provider calls). A
  mismatch between the labels, the privacy policy, and observed network behavior is a top
  rejection cause. https://developer.apple.com/app-store/app-privacy-details/
- App Tracking Transparency: only needed if OakTend tracks users across OTHER companies' apps and
  sites (ad SDKs, cross-app identifiers). First-party analytics do not trigger it. As built
  today, OakTend needs no ATT prompt and the label should say "no tracking" - keep it that way.

## 6. Review logistics (Guideline 2.1 App Completeness)

- Provide working demo credentials in App Review Information: one seeded homeowner account and
  one seeded contractor account with realistic data. Missing or broken demo logins are among the
  most common rejections.
- Reviewer notes should explain the two-sided flow and state explicitly that all payments are for
  real-world home services (heads off a mistaken 3.1.1 IAP flag on the wallet/lead fees).
- A public privacy policy URL is mandatory.

## 7. User-generated content (Guideline 1.2)

Reviews and homeowner-pro messaging count as UGC, which requires: a way to report objectionable
content, a way to block abusive users, and published contact info. Build the report/block
affordances into the iOS chat and review surfaces before submission.

## Sources

- Guidelines: https://developer.apple.com/app-store/review/guidelines/ (sections 1.2, 2.1,
  3.1.3(e), 4.2, 4.8, 5.1.1)
- Account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app/
- Privacy labels: https://developer.apple.com/app-store/app-privacy-details/
- ATT: https://developer.apple.com/app-store/user-privacy-and-data-use/
- External purchase links (US, 2025): https://appleinsider.com/articles/25/05/02/apples-app-store-guidelines-updated-to-reflect-court-order-over-external-purchases
