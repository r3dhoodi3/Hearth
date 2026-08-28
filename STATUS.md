# Hearth status (2026-08-28 morning, written by Claude overnight)

Quick-read handoff. The blow-by-blow is in `HANDOFF.md` (older) and the session notes below.
Live site: https://gethearth.vercel.app. Code: all on `main`, pushed through the commits listed under "Pushed".

## Goals (unchanged)

- Ship Hearth mainly as an iPhone App Store app; desktop must not break.
- Simple app feel (Angi-style), keep every standout feature.
- All of Orange County, honest pricing, clean subscription page.
- Safe: ownership on every request, no trial farming, moderated public text.

## Pushed overnight 2026-08-28 (both verified: tsc 0, full vitest green, eslint 0, isolated build 0, red team + checker)

1. `d2b30a2` Streaming Ask Hearth, paywall metering (2 doc reads, 1 inspection, trial 8 asks/day, home value refresh Plus-only), block/report for UGC, speed wave (one auth call per request, 15 public pages static, dashboard 2 query waves, indexes), accessibility and readability pass, phone Plus picker (no Free card, 3 in a row), home details editor, weather clock, header wrap fix, real fix for fake Messages badges, landing demo pause fix, Apple sign-in hidden behind a flag, copy freshness (all of OC, legal dates), health route, Stripe dunning notices, support digest cron, users column lock (0139), 0135 SECURITY INVOKER.
2. `29f5231` Round 2 from the 10-persona run: job post confirmation banner + visible failures, minimal phone landing (1 tap to signup), county-records fix (RentCast 404 = miss, retry, honest manual entry), condo data sanity (no building-level $34M figures), address mismatch choice, pro wizard fixes (empty city start, Other field, draft key per account, chips survive restore, error keeps the form), routing for pro accounts without a company + escape hatch, ghost-protection copy, CSLB digits-only, menu z-order, tap targets, many copy fixes.
3. `e6875a5` Round 3: Ask Hearth transcript fix (second question no longer drops the first answer; answers saved while streaming), pro Ask Hearth entry points, property type on Home details, job-post confirmation for first-time posters, address-mismatch panel fix.
4. `ROUND4HASH` Round 4 (from the 10-checker pass): claim path no longer trusts hidden parcel fields; Ask Hearth clear-while-streaming guard, cross-tab clear, empty-answer refund + idempotent refunds, abort-refund cap (5/hour), pro Ask photo gate (Pro only), trial copy; payments: trial reserved before Stripe checkout (no double trials), webhook cannot resurrect a canceled sub, free/Plus/trial numbers interpolated from one constant, dunning id guard; desktop header overlap fixed at 1024+ (address truncates instead of colliding); phone job cards 44px controls, post-job banner scrolls clear of the header, tip box shown once; app guide no longer re-opens after a tab change; pro copy/routing/legal/a11y fixes; 0140 direct-request block gate.

## YOUR morning list (in order; nothing below works until 1 and 2 are done)

1. Supabase SQL editor, in this order, each file has verify queries at the bottom:
   `supabase/PRECHECK-2026-08-26.sql` (all queries must return 0 rows) ->
   `supabase/COMBINED-2026-08-26-migrations-0129-0132.sql` ->
   `supabase/PASTE-ME-live-2026-08-27-app-feedback.sql` (0133) ->
   `supabase/PASTE-ME-live-2026-08-28-free-ai-tastes.sql` (0135) ->
   `supabase/PASTE-ME-live-2026-08-28-perf-indexes.sql` (0136) ->
   `supabase/PASTE-ME-live-2026-08-28-app-guide.sql` (0137) ->
   `supabase/PASTE-ME-live-2026-08-28-user-blocks.sql` (0138) ->
   `supabase/PASTE-ME-live-2026-08-28-users-column-lock.sql` (0139) ->
   `supabase/PASTE-ME-live-2026-08-28-blocks-direct-requests.sql` (0140, after 0139).
   Until 0129 is applied, NO new contractor can finish onboarding on live except with Huntington Beach and/or Fountain Valley (the old constraint). Every pro tester hit this.
2. Vercel > hearth > Settings > Environment Variables (Production + Preview), values from `C:\Users\lande\hearth\.env.local`: `STRIPE_SECRET_KEY` (edit), `ANTHROPIC_API_KEY` (add; it is NOT set on Vercel at all, which is why Ask Hearth is down on live), `RISK_HASH_SALT` (add; last line of .env.local, never rotate). Then Redeploy.
3. Supabase > Authentication > Sign In / Providers > Email: turn "Confirm email" back ON (I asked you to turn it off for the testers).
4. Stripe dashboard: set the public business name to "Hearth" (checkout showed "Landen Chu"); enable the webhook events `invoice.payment_failed` and `customer.subscription.trial_will_end` on the endpoint.
5. Delete the test accounts when done (SQL, service role):
   `delete from auth.users where email like 'hearth-persona-%' or email like 'hearth-test-%@example.com' or email like 'hearth-redteam-%';`
   (cascades homes, companies "TEST ... (ignore)", CRM clients, TEST (ignore) jobs.) NOTE: the contractor "2e3thyj" is YOUR OWN pro account, do not delete it.
6. Later, before the App Store build: set BOTH `NEXT_PUBLIC_APPLE_SIGN_IN=on` and `NEXT_PUBLIC_APPLE_SIGNIN=1` on Vercel (two gates, both must be on; Apple requires Sign in with Apple next to Google); read `scratchpad appstore-checklist` summary in the session notes: Plus must be sold through StoreKit/IAP inside the iOS app, block/report now exist, DMCA placeholders and `TODO(legal)` still block submission.

## Decisions I made for you (say if you disagree)

- A RentCast miss (no county record) no longer refuses the home; it proceeds to manual entry with honest copy. Refusing would have blocked real homeowners (4 real OC addresses had no record in one night). Fake addresses are caught by the street-name match against the geocoder.
- Free tier: 2 document AI reads and 1 inspection import per account, then Plus. Trialing accounts get 8 asks/day (paid 15). Home value refresh/trend is Plus; the first estimate stays free.
- Light theme stays the default with a manual toggle (4 testers wanted system dark mode; your earlier decision stands).
- The dashboard "Home value" and "Open jobs" cards are hidden on phones (value lives in Tools, jobs on the Pros tab).
- Block does not cancel an existing job; the confirm copy says so and offers End conversation.

## What the testers liked (3+ sessions each)

Honest Plus page and Stripe terms, 2 to 4 taps to an account, address autocomplete, Ask Hearth answers grounded in the home, the first-login guide, Emergency page, dark mode, plain copy everywhere, loading states.

## Still open (not done tonight)

- Capacitor/iOS wrapper, push, IAP entitlement merge, privacy manifest (App Store checklist in session notes).
- Sentry / uptime monitor (owner accounts needed), Vercel Pro + region match with Supabase.
- 46 `TODO(legal)` placeholders (DMCA agent, business address, pro-terms numbers) for the lawyer.
- Desktop header at 640-1023px still collides (brand vs nav links). Structural: the top strip switches on at `sm` but only fits at ~1024px. Fix is moving the top strip + bottom tab bar from `sm` to `lg`; that gives tablets the app shell, your call.
- Review comments moderation is done; `open_jobs_for_me` already had a LIMIT (old STATUS item was stale).
