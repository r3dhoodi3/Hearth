# App Store submission plan (OakTend iOS + Android)

Written 2026-09-07 by appstore-execute, on top of the same night's research pass
(`C:\Users\lande\oaktend-audit\reports\appstore-research.md` - read that first for the full
guideline-by-guideline reasoning; this file is the execution plan and the Landen-facing
checklist it points to). The Capacitor scaffold now exists in this repo: `capacitor.config.ts`,
`ios/`, `android/`, `src/lib/iap.ts`, `src/lib/platform.ts`, the RevenueCat webhook, and the
native UI wiring described below. Nothing here needed a Mac to build - everything past this point
does.

Supersedes `docs/APP-STORE-CHECKLIST.md`'s item 3 (that file recommended selling Plus/Pro only on
web and having the app honor the entitlement; tonight's decision, made by Fable, is IAP via
RevenueCat instead - see section "d. Decisions" below for the reasoning).

---

## a. What is wired vs stubbed (short version - full list in the execute report)

Read `C:\Users\lande\oaktend-audit\reports\appstore-execute.md` for the complete file-by-file
list. Short version:

- **Wired**: Capacitor scaffold (ios/ + android/ projects generated), remote-URL config,
  `X-OakTend-Client` platform gate (client stamp + server enforcement), RevenueCat purchase/
  restore/entitlement client calls, the RevenueCat webhook writing the same `subscriptions` table
  Stripe writes, native Apple Sign-In wiring, Apple token revocation on account deletion (with a
  documented gap - see below), Universal Links / App Links route stubs, PrivacyInfo.xcprivacy,
  Info.plist usage strings, native app-lifecycle listeners (deep links, Android back button,
  resume-refresh), an offline screen, haptics on every `SubmitButton` press, native push token
  registration.
- **Stubbed / explicitly incomplete**: actually SENDING a native push (APNs/FCM delivery - the
  token is captured and stored, nothing sends to it yet), Apple token revocation's actual HTTP
  call (the JWT-building code is real, but there is no stored Apple refresh token to revoke with -
  see "Apple token revocation" below), RevenueCat's promo/trial bookkeeping OakTend's own Stripe
  trial path does, in-app-review's real native call (the plugin was not installed - out of scope
  tonight).

---

## a2. The biggest rejection risk in this architecture: 4.2 (minimum functionality)

Added 2026-09-08 by the appstore-verify pass, because it was missing from the plan and it is the
single most likely reason a first submission bounces.

`capacitor.config.ts` uses the REMOTE-URL pattern: the shipped binary contains no app code, it
points a WebView at `https://oaktend.com`. Apple reviews this shape under guideline 4.2
("Minimum Functionality" - an app that is just a repackaged website gets rejected) and, less
often, 2.5.2. It is not forbidden and plenty of apps ship this way, but a reviewer who opens the
app and sees a website has an easy rejection to write.

What already argues against that reading, and should be pointed at in the review notes if it comes
up: native In-App Purchase (RevenueCat/StoreKit), native Sign in with Apple
(`AuthenticationServices`, not a web redirect), APNs push registration with a real device token,
haptics on primary actions, an OakTend-branded offline screen instead of the WebView's own error
page, Universal Links / App Links deep linking, and the Android hardware back button wired to the
in-app history. Those are the concrete "this is an app, not a bookmark" signals.

What would still make it safer, in rough order of value, none of which are done:
1. Actually SEND a native push (registration alone is invisible to a reviewer - see section a).
2. A native camera capture path via `@capacitor/camera` rather than the WebView's file input.
3. Offline READ of the home record (the offline screen currently only explains the outage).

If the app is rejected under 4.2, that list is the response plan, not an argument with the
reviewer.

---

## b. Apple token revocation - a real gap, not a false "done"

Guideline 5.1.1(v) requires revoking the Apple authorization when a Sign-in-with-Apple account
deletes itself. `src/lib/appleRevoke.ts` builds a correct `client_secret` JWT (ES256, signed with
`APPLE_PRIVATE_KEY`) and calls `POST https://appleid.apple.com/auth/revoke` correctly - **given a
refresh token to revoke**. Neither `deleteAccountAction` (homeowner or pro) has one to pass,
because Supabase does not persist the `provider_refresh_token` it receives during the initial
OAuth exchange anywhere queryable later (not on the user row, not on the identity row, not via
`admin.auth.admin.getUserById()`). So today, the revoke call is a documented no-op: it logs
`"no stored Apple refresh token available"` and the deletion proceeds (best effort, matching how
`eraseUserData()` already treats a partial storage purge - a right-to-delete request should not
block on a third party being reachable).

**The real fix**, not done tonight: capture Apple's `provider_refresh_token` at the moment of
first sign-in (it is present once, on the `Session` object `signInWithOAuth`'s callback exchange
returns) and store it - encrypted at rest - in a new column on `public.users`, written only for
accounts whose `identities` include an `apple` provider. `callAppleRevoke()` in
`src/lib/appleRevoke.ts` is already shaped to take that token as its one argument; wiring the
capture is the only piece left. Flagged here so this doesn't quietly ship as "handled" when it
isn't fully handled yet.

---

## c. Steps only Landen can do (a Mac, or App Store Connect / Play Console)

In order:

1. **Apple Developer Program enrollment** ($99/year), if not already done, at
   https://developer.apple.com/account.
2. **Confirm the real bundle id.** `capacitor.config.ts`'s `appId` is currently the placeholder
   `com.oaktend.app`. If that's what you want, register it as an App ID in Apple Developer
   (Certificates, Identifiers & Profiles > Identifiers) with the Sign in with Apple capability
   ticked, and as the Android `applicationId` (matches - already set the same in
   `android/app/build.gradle`). If Landen wants a different id, change it in
   `capacitor.config.ts` and re-run `npx cap sync ios android` before anything else below.
3. **Certificates and provisioning profiles.** Standard Xcode "Automatically manage signing"
   against the App ID from step 2 is the fastest path for a two-person team.
4. **Get the Apple Team ID.** App Store Connect > Membership. Replace the `TEAMID` placeholder in
   `src/app/.well-known/apple-app-site-association/route.ts` (two places) and add the
   `com.apple.developer.associated-domains` entitlement (`applinks:oaktend.com`) in Xcode's
   Signing & Capabilities tab.
5. **Android release signing.** Generate (or let Play App Signing generate) the release keystore,
   then replace the placeholder SHA-256 fingerprint in
   `src/app/.well-known/assetlinks.json/route.ts`.
6. **Xcode build.** `npx cap open ios` on a Mac, confirm it builds and runs in the Simulator
   against the live `https://oaktend.com` (or set `CAPACITOR_SERVER_URL` in `.env.native` to point
   at a staging deploy first). `npx cap open android` for Android Studio, same idea.
7. **RevenueCat account** (Landen creates this himself - see decision 3 below). Connect it to App
   Store Connect (needs the In-App Purchase Key / App Store Server API key generated in App Store
   Connect) and to Google Play (a service account JSON). Get the two public SDK keys and the
   webhook secret from RevenueCat's dashboard; set `NEXT_PUBLIC_REVENUECAT_IOS_API_KEY`,
   `NEXT_PUBLIC_REVENUECAT_ANDROID_API_KEY` in `.env.native`, and `REVENUECAT_WEBHOOK_SECRET` on
   the Vercel web deploy (the server that runs `src/app/api/iap/webhook/route.ts`) - **and the
   identical secret string in RevenueCat's own webhook config screen.**
8. **IAP product setup in App Store Connect and Play Console.** Create the subscription products:
   - OakTend Plus: weekly / monthly / yearly, matching `PLUS_PLAN` in `src/lib/constants.ts`
     ($1.99/wk, $4.99/mo, $39.99/yr as of this writing - re-check the constant, it is the source
     of truth). RevenueCat entitlement id: `oaktend_plus` (see `src/lib/iap.ts`), offering id:
     `oaktend_plus`.
   - OakTend Pro: monthly / yearly, matching `PRO_PLAN`. Entitlement id: `oaktend_pro`, offering
     id: `oaktend_pro`.
   - Configure each product's free trial (Apple calls it an "introductory offer") to match
     `PLUS_PLAN.trialDays` / `PRO_PLAN.trialDays` - this is a SEPARATE mechanism from Stripe's
     trial and has to be rebuilt here, not inherited from the web checkout code.
   - Attach the products to the offerings above in the RevenueCat dashboard, so
     `getOfferings()`/`purchasePackage()` in `src/lib/iap.ts` finds them.
9. **App icon.** A single 1024x1024 source PNG for Xcode/Android Studio's asset-catalog
   generators. The existing `src/app/icon.svg` / `icon-192.png` / `icon-512.png` are for the web
   manifest and are not directly usable as the source - regenerate from the same artwork at full
   resolution.
10. **Screenshots** for each required device size (6.9" and 6.5" iPhone at minimum). Needs a
    running build (step 6).
11. **Demo account (see section "e" below).**
12. **App Review notes** - paste the draft in section "f" below into App Store Connect's App
    Review Information > Notes field, filled in with the real demo credentials.
13. Submit. If a reviewer pushes back on the lead-fee/wallet-deposit Stripe flow as an IAP
    violation, respond with the same 3.1.3(e) framing from section "f".

---

## d. Decisions (Fable's recommendation on each, made 2026-09-07 so tonight's build wasn't
blocked waiting on Landen)

1. **Pricing parity.** Charge the SAME price on iOS/Android IAP as on the web, and eat Apple/
   Google's commission (15% under $1M annual proceeds via the Small Business Program - verify
   OakTend qualifies and enroll - or 30%/15% otherwise) rather than pricing the app higher to
   offset it. Add a plain "cheaper on the web" text link near the native paywall for US users -
   the 2025-2026 Epic v. Apple ruling currently allows this at 0% Apple commission for
   US-storefront apps (see the research report section 1) - **not done in this pass's UI**
   (`NativePlusCheckout.tsx`/`NativeProCheckout.tsx` do not yet carry that link; add it once the
   web pricing page's own URL and copy are finalized). Reasoning: same price everywhere is the
   simplest, most honest reading of the existing design principle ("plain human copy, no
   buzzwords") from this app's own design preferences, and a visible savings link beats a hidden
   price gap.
2. **Do not hide pricing on iOS.** Show the real price on the native paywall before the purchase
   sheet opens, same as the web pricing page always has. Hiding it until the native sheet appears
   is a real pattern some apps use to nudge people toward the cheaper web checkout, but it reads
   as dark-pattern-adjacent and directly contradicts the pricing page's own upfront-disclosure
   ethos. `NativePlusCheckout.tsx`/`NativeProCheckout.tsx` already show the price plainly.
3. **RevenueCat account: Landen creates it himself.** It touches App Store Connect API keys and
   Play Console service-account credentials - billing-adjacent infrastructure that should be
   under the owner's own login, not created by an agent session and handed over. Free tier covers
   roughly $2.5k/mo tracked revenue as of the research pass (verify the current number at
   signup - it moves).
4. **Family Sharing: OFF** for both OakTend Plus and OakTend Pro IAP products at launch. Plus is
   tied to a specific home/property and Pro to a specific contractor business identity, so a
   single purchased entitlement shared across a family group doesn't map onto either product.
   It's a one-way-off-to-on toggle in App Store Connect if this is ever revisited.
5. **Android follows iOS**, not simultaneous. `npx cap add android` was run tonight (cheap, done
   regardless), and the Capacitor/RevenueCat code is platform-agnostic, but Landen should get the
   iOS submission through review first before spending the App Review notes / demo-account /
   screenshot effort twice in parallel. Nothing in the codebase blocks Android from shipping
   sooner if Landen prefers otherwise - it's a sequencing choice, not a technical constraint.

---

## e. Demo account requirement (Guideline 2.1)

Needs a STANDING account on the live database (not an `oaktend-test-*` throwaway - those are a
different lifecycle for tonight's other testing streams and may be deleted), one homeowner and
one contractor, each pre-seeded with representative, non-empty data:

- Homeowner: at least one claimed property with a few home systems entered, a maintenance plan
  built (so the dashboard and forecast pages aren't zero-states), and one posted job or one
  message thread with a pro.
- Contractor: a complete public profile, at least one active lead/application, so `/pro/leads`
  and the chat surface show real content.

Create both, set real passwords, and put the credentials in App Store Connect's App Review
Information > Notes field alongside the text in section "f". This is a Landen-only task (outside
tonight's throwaway-account rule) - not created by this pass.

---

## f. App Review notes draft (paste into App Store Connect)

```
OakTend is a two-sided home-services marketplace: homeowners track their home's systems and
maintenance, and post jobs; licensed contractors ("pros") browse and apply to those jobs.

DEMO ACCOUNTS
Homeowner: [Landen fills in email/password]
Contractor: [Landen fills in email/password]

WHY MOST PAYMENTS USE OUR OWN CHECKOUT (STRIPE), NOT IN-APP PURCHASE
Two kinds of purchase exist in this app, and they are handled differently on purpose:

1. OakTend Plus (homeowner) and OakTend Pro (contractor) MEMBERSHIP SUBSCRIPTIONS unlock digital
   features inside the app (AI-assisted tools, unlimited chat with our AI assistant, document
   analysis, priority job matching). These go through Apple/Google In-App Purchase, per guideline
   3.1.1, via RevenueCat.

2. LEAD FEES ($25-$99, paid by a contractor to be introduced to a specific homeowner's posted job)
   and WALLET DEPOSITS (a contractor pre-funding their lead-fee balance) use our own Stripe
   checkout, not IAP. These purchase access to a real-world home-repair job that is performed and
   consumed entirely outside the app, at the homeowner's house - the same category guideline
   3.1.3(e) describes ("goods or services that will be consumed outside of the app"), and the same
   model established home-services marketplace apps use for their own lead-fee products (Thumbtack,
   Angi, TaskRabbit, HomeAdvisor all sell lead credits to their pros through their own payment
   rails, not platform IAP). Nothing purchased through this flow unlocks any additional in-app
   feature, screen, or content - it is solely the fee to be introduced to one specific job.

To see this flow: sign in as the contractor demo account, go to the Jobs tab, and apply to any
open job - the fee screen there is the Stripe flow described above.

We're happy to discuss this further if there are questions about the distinction.
```

---

## g. Privacy nutrition label mapping (App Store Connect "App Privacy" + Play Console "Data
safety" - same underlying questions, same answers apply to both)

Source of truth for what is actually collected: `src/content/legal/ai-disclosure.md`,
`src/content/legal/privacy.md`, and the codebase scan in the research report section 1/3. No
ad or attribution SDK exists in `package.json` (no Segment, Mixpanel, Meta Pixel, Google
Analytics) - `/api/track` is a first-party analytics beacon into OakTend's own `app_events`
table. The one analytics dependency is `@vercel/analytics` (added 2026-09-09), the hosting
provider's cookieless page-view counter: no cookie, no cross-app identifier, no ad network, so
it does not change the tracking answer below.

| Data type | Collected? | Linked to identity? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Name | Yes | Yes | No | App functionality (account) |
| Email address | Yes | Yes | No | App functionality (account, auth) |
| Phone number | Yes | Yes | No | App functionality (account, optional SMS) |
| Physical address | Yes | Yes | No | App functionality (the home being tracked) |
| Precise/coarse location | No | - | - | Not collected - no `navigator.geolocation`/CoreLocation call found in the codebase as of this scan. Re-verify if that ever changes. |
| Photos | Yes | Yes | No | App functionality (job/system/document photos) |
| Payment info | Yes | Yes | No | App functionality - processed by Stripe and (on native) Apple/Google + RevenueCat; OakTend itself stores only a plan/status row, never card numbers |
| User content (chat messages, job posts, reviews) | Yes | Yes | No | App functionality |
| Customer support data | Yes | Yes | No | App functionality (support messages) |
| Third-party AI processing | Yes (Anthropic Claude, via `src/lib/claude.ts`) | Yes | No | App functionality (Ask OakTend, document/quote analysis). Disclosed in-product every session per `ai-disclosure.md`; not used for ad targeting; per that doc's stated position, not used by Anthropic to train models under OakTend's commercial API terms. **Apple's 5.1.2(i) specifically names third-party AI sharing** - call this out explicitly as its own row/note in App Store Connect, not folded into a generic "app functionality" bucket. |
| Third-party data enrichment (RentCast/Regrid parcel lookups) | Yes - a homeowner's typed address is sent OUT to get parcel/home-value data back | Yes (tied to the address/account) | No | App functionality (home-value estimate, onboarding pre-fill). Frame as "address shared with a service provider for a home-value estimate" if the label schema wants a location-sharing note. |
| Identifiers used for analytics | Yes (`/api/track`, first-party). Vercel Web Analytics adds no identifier: it is cookieless and keeps nothing that lasts beyond a day | Yes when signed in, for `/api/track` only | No | Analytics (first-party; dollar amounts and sensitive numbers explicitly excluded from event props per that route's own code) |

**Tracking**: No. No cross-app/cross-company identifier is collected, no ad network SDK exists.
Per Apple's own ATT scope ("tracking across other companies' apps and sites requires ATT
consent; internal analytics within your own app does not"), **no ATT prompt is needed** unless a
future ad SDK or attribution tool (Meta SDK, AppsFlyer, etc.) is added - revisit this table if
that ever happens.

---

## h. Files this pass created or changed (see execute report for the full list with purposes)

Full file-by-file list with a one-line purpose each, wired-vs-stubbed status, and typecheck/test
exit codes: `C:\Users\lande\oaktend-audit\reports\appstore-execute.md`.
