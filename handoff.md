# Hearth handoff

> The dated sections below are the running history, newest additions at the top.
> Start with **LATEST** for the current state and what is still owed.

---

## LATEST (2026-08-30 late night): interactive UX + feature wave

Read this first. It covers the whole overnight of 2026-08-30 (two waves) and what is still owed.

### Goals
Landen asked, in order: (1) run a big security + bug audit and fix everything (agents),
(2) push when green and smoke-test Vercel, then a run of live product requests: make a
"feel-good" share feature, PWA/TestFlight install steps, fix a blank-screen on the installed
PWA, add a "credit-back when a pro loses a bid" flow, decide the refund %, fix confusing
wording, make share cards share a real image not a link, turn the "Try Pro" prompt into a
full-screen paywall, permanently dismiss a repeating "confirm your home" popup, and fix phone
text getting cut off.

### Current state
Live: **main `472e34d`, deployed + smoke-tested green** (health ok, db ok, version 472e34d,
public pages 200, wins-card share route public). Live DB: **still through 0150** until the
SQL below is pasted. Gate on every push: tsc 0, eslint 0, vitest 245 files / 3201 passed,
isolated build 0. Commits tonight: `7acac7e` (security wave), `45bf94f` (Home Wins), `350766d`
(wins-card middleware fix), `472e34d` (UX wave). Push permission was a one-night exception.

### THE ONE OWNER ACTION THAT IS STILL BLOCKING DB-SIDE FIXES
**Paste `supabase/PASTE-ME-live-2026-08-30-night.sql` into the Supabase SQL editor.** It holds
migration 0151 (household member cap, is_pro_member active-only, system-message forgery lock,
contractors public-text CHECK, expire_bonus revoke, messages delete policy, properties unique
index). It has a PRECHECK that refuses a double-run and a heads-up query for any home already
over the 4-member cap. Until pasted, those DB protections are NOT live (the code is).

### Files touched (both waves)
Security wave: ~59 files (payments/webhook, chat, dashboard, pro onboarding/profile/CRM,
onboarding/auth, AI metering, subscription) + migration 0151 + PASTE-ME. UX wave: dashboard
(ReminderItem, WalkthroughNudge, page), pro billing (BillingView, ActivityList, page), pro
layout, leads/LeadsBoard, pros/page, pro-ask route, guaranteeCopy, reviewPrompt, ProTrialNudge,
share components (HomeWinsShare, pro/WinShareButton, pro/ReviewShareRow), plus new Home Wins
files (lib/homeWins, api/wins-card, HomeWinsShare) and the middleware allowlist.

### What changed / What worked
- SECURITY (7acac7e): closed a CRITICAL deposit-chargeback-freeze hole, deposit velocity cap,
  pro double-sub/unreachable-customer, Plus-blocked-from-Pro, household DB cap, trial-discount,
  system-message forgery, Ask assistant-turn injection, free-user Plus mislabel, duplicate
  homes, double-submit latches, Next.js 15.5.24 (AVIF RCE). 16-agent audit -> 7 workers -> 3
  verifiers. No cross-tenant breach or auth bypass found.
- HOME WINS (45bf94f + 350766d): new positive-only shareable card (years on Hearth, systems in
  great shape, tasks handled; encouraging starter for new homes; NO score, NO dollar figure).
  Public OG card /api/wins-card/[code], privacy-verified (first name + counts only, no
  address/value). Dismissible dashboard card. Removable in ~4 files. Middleware fix made the
  share route publicly fetchable (it was 307ing to signin - caught by smoke test).
- UX WAVE (472e34d):
  - Lead-credit WORDING was actually WRONG (root cause of Landen's confusion): copy + the Ask
    Hearth Pro AI prompt still described the pre-0107 rule ("only first bid, then a lost bid is
    a lost fee, license required"). Rewrote every instance to the true rule: every lost bid gets
    100% back as credit (not cash), no limit, 60 days. Copy only, no logic change.
  - "Try Pro 3 days" -> full-screen takeover paywall (X, wordmark, "3 Day Free Trial", plan
    cards + Save% badge, Start-free-trial CTA, auto-renew + Privacy/Terms, NO reviews). Mounted
    once in the pro shell, gated by the ReviewPrompt smart-timing algorithm, excluded from home
    pages AND the pro Home tab (/pro exact), never stacks with the review prompt.
  - Share cards now share the REAL image (navigator.share files) with link + download fallback:
    Home Wins, pro win card, pro review card.
  - "Confirm your home" (WalkthroughNudge) now dismisses PERMANENTLY (was reappearing after 14d).
  - Phone: dashboard task titles WRAP and show in full instead of clipping to a few chars.

### What failed / was caught
- The SQL PASTE-ME had a self-aborting precheck (would have applied NOTHING on a fresh DB) -
  caught by a verifier, fixed. LOW-55 (expire_bonus) was a false finding (0020 already did it).
- 6 regression must-fixes in the security workers' output (mobile zoom no-op, dedup missing
  unit, wrong cap message, CRM legacy-note orphan, label drift, cap heads-up) - all fixed.
- The Home Wins share route was behind auth (307 to signin) - caught by smoke test, fixed.
- The pro paywall was first mounted billing-page-only (would rarely fire) - moved to the shell.
- The installed-PWA blank screen Landen hit was a transient first-load/cold-start (start_url
  redirects to signin); it resolved on retry. NOT fixed in code yet - see offer below.
- Not verifiable without a device/live keys: real iOS behavior, real Stripe/push/Twilio, 0151
  on a real DB.

### Next steps (OWNER)
1. Paste the SQL (above). 2. Everything on the older owner list still stands (VAPID +
   RISK_ENFORCE env, Supabase Auth settings, Stripe live prices, RLS audit + backups, delete
   test accounts). 3. Try the app from your Home Screen icon (add-to-home-screen is the biggest
   "feels like an app" lever). 4. TestFlight later (you have an Apple Developer account) via a
   Capacitor wrapper.

### Notes / decisions / open offers
- REFUND POLICY: KEEP 100%-always (decided, research-backed: it is the opposite of the #1
  lead-gen complaint, and the 3-applicant cap already prevents over-bidding). Future levers, NOT
  now: shorten credit expiry to 30-45d for breakage; a Pro-membership-tied version (members keep
  100%, free tier less) as a subscription driver.
- The credit-back-on-loss feature ALREADY EXISTED (migration 0107) + already notifies losers.
  OPEN OFFER, not built: add "apply_credit_back" to PUSH_NOTIFICATION_KINDS (one line) so the
  loser also gets a phone push. Also an OPEN OFFER: code-fix the PWA start_url so the blank
  screen can never recur (point the launch URL at a non-redirecting page).
- App-feel punch list (researched, NOT built): kill the gray tap-highlight flash, add a pressed
  state to the bottom tab bar, tame the overscroll bounce. All cheap CSS, mobile-scoped. See
  [[hearth-app-feel-brief]].
- Research memos from tonight (in the session scratchpad, not the repo): share-card ideas,
  app-feel audit, home-tracking data sources (RentCast + Photon + Open-Meteo + CPSC), lead
  refund policy.

---

## (2026-08-30 night): security + bug remediation wave

### Goals
Landen's ask: run a big audit (10 bug agents + 3 money hackers + 3 security researchers),
fix everything with Fable planning and subagents executing, loop until perfect, push when
green and smoke-test Vercel. Mid-wave he also asked three research questions (answered, memos
in the session scratchpad): where home tracking pulls from, viral-share ideas (Wrapped/Strava),
and what makes the app feel native on iPhone.

### Current state
Gate GREEN: tsc 0, eslint 0 (2 pre-existing OG-card img-alt warnings only), vitest 241 files
/ 3126 passed, isolated production build exit 0. Next.js bumped 15.5.23 -> 15.5.24 (AVIF
image-optimizer RCE patch, GHSA-2xp9-vwfh-vxw4). Three adversarial verifiers all cleared
(payments all CONFIRMED-FIXED, SQL all correct after a blocker fix, regression 6 must-fixes
applied). PUSHED to main this commit. **Live DB still through 0150** until Landen pastes the
new SQL (below).

### Files touched
59 modified + 8 new. Payments: api/stripe/webhook, pro/plus/actions, pro/billing/actions +
DepositForm, pro/plus/ProPlanToggle, (app)/plus/actions. Chat: LeadChat. Dashboard/mobile:
HomeAlerts, WeatherStrip, dashboard/page+loading, ReminderItem, GlobalSearch. Pro: onboarding
wizardSteps+OnboardingCompanyForm, profile/PublicProfileForm, actions, crm/actions+[id]/page,
HomeView, leads/LeadsBoard+page, plus/PlusScreens, JobStatusSelect, new leadStatusLabel.ts,
PhoneInput. Onboarding/auth/notify: onboarding/actions+OnboardingForm, sideActions,
contractor-signup, NotificationBell. AI: api/ask, api/pro-ask, AskHearth, api/home-alerts,
api/pro-widget, next.config.mjs. Subscription: lib/subscription (new hasActivePaidProPlan).
NEW SQL: supabase/migrations/0151_night_security_2026_08_30.sql +
supabase/PASTE-ME-live-2026-08-30-night.sql.

### What changed (by severity)
CRITICAL: deposit chargebacks now trip the account freeze (stolen-card deposit-then-dispute
loop closed). HIGH: deposit velocity cap (fail-closed 3/day + 24h ceiling); pro checkout can
no longer mint two unreachable subscriptions (pro_trial reservation + reachable Stripe
customer); Plus member no longer blocked from buying Pro (price-id match); household member
cap enforced at the DB (one Plus sub can't feed unlimited alias AI - migration 0151);
contact_phone validated client+server; HomeAlerts freeze/recall panel no longer silently
hidden on soft nav; chat no longer snaps to bottom on every poll; three dashboard 390px
overflow fixes. MED: is_pro_member active-only so a free trial can't get the 10% lead discount
(SQL + TS preview aligned via hasActivePaidProPlan); system-message "Hearth verified..."
forgery blocked (0151); Ask Hearth client-authored assistant-turn injection dropped; free
users no longer mislabeled Plus on refusal paths; duplicate home rows blocked (code guard +
unique index incl. unit); double-submit latches across pro checkout/deposit/finish/plus
buttons; CRM note timeline + Active-jobs link + status-label drift; home-alerts + pro-widget
metering. LOW: expire_bonus/messages-delete/contractors-text DB hardening (0151), CSP
unsafe-eval prod-gated, mobile tap targets, contractor-signup friendly errors, side-switch
DB-hiccup guard.

### What failed / caught before shipping
- The SQL PASTE-ME had a self-aborting precheck (tested has_function_privilege for a revoke
  that migration 0020 already did, so it would raise on a FRESH DB and apply NOTHING). Caught
  by the SQL verifier, fixed. LOW-55 (expire_bonus never revoked) was a FALSE finding - 0020
  already handles it; the 0151 statements are harmless idempotent re-assertions.
- The regression verifier caught 6 real must-fixes in the workers' output (GlobalSearch zoom
  no-op, onboarding dedup missing unit = silent multi-unit-landlord data loss, wrong plan
  message on a cap race, CRM legacy-note orphan, JobStatusSelect third label copy, missing
  cap heads-up) - all fixed and re-gated.
- Not verifiable without a device/live keys: real iOS behavior, real Stripe/push/Twilio,
  0151 on a real DB.

### Next steps (OWNER)
1. **Paste `supabase/PASTE-ME-live-2026-08-30-night.sql` in Supabase** (has a PRECHECK that
   refuses a double-run, plus a heads-up query for any home already over the 4-member cap).
   Until then the DB-side fixes (household cap, trial-discount, system-message lockdown,
   contractors text CHECK, messages delete policy, properties unique index) are NOT live.
2. Everything on the daytime handoff's owner list still stands (VAPID + RISK_ENFORCE env,
   Supabase Auth settings, Stripe live prices, RLS audit + backups, test-account cleanup).
3. Non-blocking follow-ups from the verifiers: Plus-side customer symmetry + LOW-34 retry
   parity on the pro side; resolveDepositSession redeliver-on-transient-error; confirm 3
   deposits/day is fine for heavy pros; the three research memos (share cards, app-feel
   punch-list, home-tracking sources) are in the session scratchpad for when you want them.

---

## (2026-08-30 day): daytime wave shipped to main `4cc627f`

Live: **main `4cc627f`, deployed and healthy** (version endpoint reads 4cc627f; /, /pros,
/pricing, /fountain-valley, /signin, /p/<x>, /api/health all return 200; DB ok).
Live DB: **through migration 0150** (owner ran `supabase/PASTE-ME-ALL-PENDING-2026-08-30-day.sql`
= 0147 reserve, 0148 perf indexes, 0149 Pro lead discount, 0150 pin lead created_at).
Gate before push: tsc 0, eslint 0, vitest 237 files / 3063 passed, isolated build 0.

What shipped in 4cc627f (227 files): pro Home tab first + billing parity; 3-day trial on
every plan cadence; forecast value features + repair reserve; bigger draft button + bold
"lead credit (not cash)" disclaimers; application messages in pro Messages; Pro members 10%
off lead fees (never stacked with aging); legal pages. Research-driven polish (RA-RE):
homeowner conversion nudges, sharing surfaces (before/after + PDF share, printable pro QR,
post-job referral asks), pro convenience (tools prefill, quick status texts, offline draft
autosave, batched alerts), trust copy + dated badges, notification cap + Stripe dunning
follow-up. Speed: first-load JS down 31-38%, instant Leads sort, perf indexes, faster
middleware. AI: Haiku routing for cheap tasks, abuse ceilings. Security (red team + retest):
0150 back-dating fix, AI output budget on disconnect, /api/track props sanitizer.

### STILL ON THE OWNER (do these; nothing is blocking the site, but each unlocks something)

- [ ] **Vercel env + redeploy:** add `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
      `VAPID_SUBJECT` (values in the session scratchpad `vapid-keys-2026-08-29.txt`) and set
      `RISK_ENFORCE=true`, then Redeploy. Unlocks push notifications + risk enforcement.
- [ ] **New dunning cron:** `/api/cron/dunning-followup` is in `vercel.json` (daily). It uses
      the existing `CRON_SECRET` (already set) - just confirm it runs after the next deploy.
- [ ] **Supabase Auth settings:** confirm-email ON, session length 30d, URL config, reset
      email template, secure password change, CAPTCHA, rate limits. Then test forgot-password
      from your phone.
- [ ] **Supabase RLS + backups:** run `AUDIT-rls-2026-08-29.sql` and review results; confirm
      the backup plan and do one restore drill.
- [ ] **Stripe:** create live Prices and set `STRIPE_PRICE_PLUS_*` / `STRIPE_PRICE_HOME_SLOT_*`
      in Vercel; void the draft invoice `in_1UA4fFDxdfZrb1rtI92Ihy2B`.
- [ ] **Delete throwaway test accounts** (full list in the session scratchpad
      `morning-owner-checklist.md`). Never delete `test1@hearth.app` or your `2e3thyj` pro account.
- [ ] **Vercel firewall** rule on `/api/health`; **environments split** per `docs/ENVIRONMENTS.md`;
      **Apple key rotation** before turning Apple sign-in back on.
- [ ] **Optional:** run the 5-agent live check on `4cc627f`, or click through the phone yourself.

### Open product decisions (my recommendations, not blockers)

- Drop `src/app/pro/loading.tsx` to remove the last cosmetic console-only React #418 on pro
  routes (page renders fine either way) - your call.
- Universal review-ask (currently Pro-only): recommend yes.
- Cancellation save-flow (pause/downgrade before hard cancel): recommend building next.
- In-house services (lawn/pool): pool has the best economics; separate LLC + licensed crew
  only; hold until liquidity. Legal writeup in scratchpad `research-money-R5.md`.
- Data monetization: aggregate insights only, never sell personal data (my standing position).

### What did NOT work / was caught before shipping
- A stray `*/` inside a CSS comment closed the comment early and broke the build (fixed).
- Scripted edits flip line endings to CRLF on Windows and broke source-pattern tests (fixed;
  lesson saved to memory).
- Research agents had web-search quota exhausted; some market numbers are general-knowledge,
  flagged unverified in the reports.

---

## Hearth handoff (2026-08-24)

Snapshot after the overnight build + the 08-23/24 morning items shipped and the
live test site was wired up. Everything below is on `main` and deployed to
https://hearth-seven-pink.vercel.app unless marked otherwise.

## RESUME HERE: the live 5-agent test (not yet run)

Landen will clear the chat, then run a step-by-step mobile test on the LIVE site
with 5 agents: 2 homeowner, 2 pro, 1 switching back and forth. Fresh test
accounts already exist on the live Supabase project (created 08-24, email
confirmed; password is in the session scratchpad LIVE-README, NOT in this repo):

- `hearth-test-1@example.com`  (homeowner)
- `hearth-test-2@example.com`  (homeowner)
- `hearth-test-3@example.com`  (pro)
- `hearth-test-4@example.com`  (pro)
- `hearth-test-5@example.com`  (dual: homeowner + pro, switch back and forth)

Sign-in inputs are `#email` / `#password`. Use the Playwright runner at
`C:\Users\lande\AppData\Local\Temp\claude\C--Users-lande\<session>\scratchpad\mobile-audit\`
(PERSONA-README.md there; set `base` to the vercel URL). None of these accounts
own a home or company yet, so each agent will go through onboarding first. When
done, delete them: `delete from auth.users where email like 'hearth-test-%@example.com';`
(service role). NOTE: to actually reach Ask Hearth on the live site the account
needs a claimed home; claiming needs a REAL Orange County address (the address
suggest + county lookup will reject fakes by design).

## Current state (verified)

- `main` at `1359455` == origin. Two commits this cycle: `1cf7b43` (night build)
  and `1359455` (morning items). tsc clean, 474 Vitest tests (37 files), eslint
  0 errors, `next build` exit 0.
- LIVE DB: migrations 0127 + 0128 applied 08-24 (Landen pasted
  `supabase/PASTE-ME-live-2026-08-22-combined.sql`; verify queries all returned
  as expected, address constraint convalidated = true). That paste also ran the
  audit-account cleanup, so the OLD `hearth-audit-p1..p4` accounts are deleted
  (the new `hearth-test-*` above replace them).
- Vercel env fixed 08-24: `SUPABASE_SERVICE_ROLE_KEY` corrected (it was wrong,
  which had made every /pro route bounce to onboarding and Finish setup 500),
  `ANTHROPIC_API_KEY` added. Verified live: sitemap lists 4 pros again, so admin
  reads work. Still to add when ready: `TWILIO_*` (SMS dormant until then).
- Dev server: `npx next dev -p 3100` (has the real Anthropic + Twilio keys, so
  AI and address-suggest work locally).

## What shipped

### Night build (1cf7b43)
- Dark mode opt-in (light default). Google sign-in role loop fixed (the
  contractors row, not the `?next=` door, decides who is a pro). One account can
  hold BOTH sides; profile menu switches ("Switch to your business" / "Switch to
  your home"). Layouts gate on rows; role metadata is only the landing side.
- Pro onboarding 3-step wizard; Yelp/Google review links on the /pro checklist.
- All AI on Anthropic Claude Sonnet 5 via the SDK; Gemini removed; voice
  on-device. Prompt caching fixed (nonce was defeating it). thinking off +
  effort low on chat (~20% faster).
- Ask Hearth limits: 3/day free text, 15/day Plus with photos, 6/min chat
  burst, 10/5min tool burst, 1500/hour global brake, fail-closed, atomic
  refunds, bounded request bodies on all 13 AI routes, home-only topic guard,
  claimed home required.
- Mobile (3-agent display audit + 4 personas): header overlap, 404 page,
  privacy cards, weather strip (night labels, 7-day tap forecast, ZIP fallback,
  8s deadline), ~40 tap targets, home-report CTA, emergency textarea zoom, CRM
  loading state, billing table, post-a-job option values, per-system
  placeholders, Ask Hearth retry for an orphaned question, cycling wait pill.
- Security (2 sweep rounds): middleware matcher anchored to asset prefixes
  (`.png` suffix no longer skips auth), /ask guarded with a drift test, sitemap
  filtered, custom category moderation at write AND render, upload path
  ownership, privacy/AI pages name Anthropic. 24 junk contractor rows deleted.
- Discoverability: manifest with maskable icons, robots, sitemap (5 guides were
  missing), canonicals, Organization + WebApplication JSON-LD.

### Morning items (1359455)
- OC address autocomplete (Photon, server route, rate-limited); "couldn't find
  that address, try another" when the county has no record; fakes can no longer
  be claimed (that was why a fake-address home showed no systems). Systems were
  already seeded on every successful claim.
- Plus page three columns on phone (Monthly | Annual middle | Free); the 3 free
  days are on Monthly only (Stripe verified both); annual billed day one. No
  exit popup (deliberately not built).
- Self-service home deletion removed (people could cycle homes to reset the
  free-home cap); "Contact us" line instead; server refuses a replayed delete.
- Ask Hearth moved into the Messages tab (pinned row) on both sides; bottom nav
  back to 4 tabs.
- Household QR link `[object Promise]` fixed (missed await from Next 15).

## What worked

- Probing the live site directly (sitemap pro-count, a signed-in API call)
  caught the wrong Vercel service-role key that a code review could not: the
  "contractor page doesn't work on iPhone" was that env var, not code.
- Green-before-push: tsc + 474 tests + eslint + an isolated production build
  before each push.
- Adversarial sweeps found real defects personas would hit later: pro-profile
  save 500 (missing column grant), chunked-upload body-guard bypass, non-atomic
  refund that let two tabs beat the daily cap. All fixed and re-verified.
- PASTE-ME SQL discipline with inline verify queries.

## What did NOT work / went wrong

- The auto-mode guard blocked `git commit` and `git push` even with go-ahead;
  Landen ran the commit from the prompt once, then pushes went through. Expect
  to run pushes manually.
- Two subagent overreaches (now a standing prompt rule): one minted a session
  for a REAL user via the service-role admin API (read-only) to test rate
  limits; another signed a real browser session out to log in as a test
  account. No data changed, but ROTATE the Supabase service-role key, the
  Anthropic key, and the Apple key `34UDQ3MTXM` this week (all exposed in chat
  or used by an agent).
- Concurrent `next dev` on one `.next` corrupted it twice (chunk 404s, dead
  hydration); fixed with one server on 3100 + isolated dist dirs. Several
  persona "blockers" were this, re-verified clean.
- Ask Hearth answers still take 10+ seconds; streaming is the next real lever.

## Next steps

1. Run the 5-agent live test above, fix what it finds, delete the test accounts.
2. Landen: add `TWILIO_*` to Vercel when turning SMS on; rotate the three
   exposed keys; test Apple sign-in on the phone with a real Google account.
3. Ask Hearth streaming (latency); a home-details editor (year built / sqft /
   beds / baths have no post-onboarding form).
4. William: `docs/WILLIAM-SECURITY-INFRA.md` (14 items). Legal:
   `docs/LEGAL-TODO.md`.

## Notes / decisions to sanity-check

- Annual Plus has no free trial now (billed day one). Revert in
  `src/lib/billingTerms.ts` (`trialApplies`) if you meant the trial on both.
- Ask Hearth in Messages replaced the separate Ask tab built earlier that night.
- Condo units are display-only: ownership match is street-level, a unit claim is
  recorded "unverified" on purpose (the provider returns the building record).
  Consequence: a condo owner's job post will not fan out over email/SMS until
  ownership is confirmed another way.
- Working agreements unchanged: no em dashes; commit + push only on an
  in-the-moment go-ahead; live DB changes as PASTE-ME files; mobile-first,
  desktop byte-identical (gate with `max-sm:`).

## Live 5-agent test: results (2026-08-24 evening; T1-T4 done, T5 dual DIED on an API error mid-run, re-run it after blocker 1 is cleared)

Runner + shots + step files: `C:\Users\lande\AppData\Local\Temp\claude\C--Users-lande\8e2f05c5-3123-489a-bab9-8300d02acedf\scratchpad\live-test\` (LIVE-README.md there; NODE_PATH must point at the old mobile-audit node_modules).

BLOCKERS on live
1. Homeowner onboarding rejects EVERY real address ("We couldn't find that address"). T1 and T2 tried 6 real HB/FV addresses, all rejected. Cause: RentCast call failing on Vercel; `src/lib/parcel.ts` returns null for 401/429/timeout AND for a true miss, `src/app/onboarding/actions.ts:318` refuses both, and the miss is cached 24h in parcel_cache. The local key (`.env.local`) returns a full record for 9063 Warner Ave. Landen added `RENTCAST_API_KEY` to Vercel + redeployed 08-24 evening; retest still rejected (cache not cleared yet). TODO: run `delete from parcel_cache where source = 'none';` (service role), then retest a claim. CODE FIX still needed: third ParcelFacts source ("unavailable") for HTTP errors/timeouts, not cached, not refused, falls back to manual entry.
2. /pro/plus "Try Pro free for 3 days" -> server 500 + error boundary (Stripe checkout never loads). shot t3-38.
3. Ask Hearth on the pro side: "temporarily unavailable" within 500ms. Check ANTHROPIC_API_KEY on Vercel really applied (redeploy after adding?). Homeowner-side Ask untested (blocked by 1).

BAD / ANNOYING
- Address autocomplete needs the city typed; street-only ("Magnolia", "Heil Ave") returns nothing, placeholder gives no hint. Some queries return unrelated streets. (T1, T2)
- Pro CRM "Add a client" has no phone field; the creation-time note does not appear in the client detail Notes timeline ("No notes yet"). (T3)
- Pro wizard step 2 accepts junk custom category ("asdf shit") on Next; server only rejects at Finish. Reject on the step instead. (T4)
- Phone field silently strips "abc" to empty, no inline error until Next. (T4)
- /pro/profile Save can be double-tapped: two requests, two toasts. (T4)
- Wizard step 2 picks lost on reload (step 1 persists). (T4)
- /pro inline links under 40px tall (Add license, Add reviews link, Browse jobs, Help...). (T4)
- Fake-address rejection leaves a stale suggestion card overlapping Unit/ZIP. (T2)
- /welcome/role card pinned top-left with empty space on phone. (T1, T2)

WORKED: sign-in, role picker, pro 3-step wizard incl. Finish setup (no more 500), /pro checklist w/ review links, pro bottom nav, profile save + public /p page, CRM add w/ loading state, dark mode toggle, privacy page names Anthropic, sign-out/in lands on /pro, pro hitting /dashboard bounces to /pro, route guards before onboarding, no overflow anywhere, fontcheck clean.

CLEANUP when done: `delete from auth.users where email like 'hearth-test-%@example.com';` (cascades companies "Test Plumbing (ignore)", "TEST Handyman (ignore)", "TEST Dual Electric (ignore)" if created, CRM lead "TEST (ignore) Jane"). No job posts, no contacts, no Stripe subscriptions were created.

## 2026-08-26 session (in progress): fixes wave after the live test

Blocker 1 (address rejection) CONFIRMED FIXED on live after Landen added RENTCAST_API_KEY to Vercel + redeployed + cleared parcel_cache misses: claims now reach the confirm step and the dashboard (7 systems, weather). Homeowner testers T1b/T2b/T5b re-run OK past onboarding.

Still broken on live, OWNER ACTIONS:
- Ask Hearth (both sides) still "temporarily unavailable" after Landen added a NEW Anthropic key (created 08-26, named for Vercel production) and redeployed. The route's hasClaudeKey() reads process.env.ANTHROPIC_API_KEY at runtime, so the deployment does not see it: check the var is on the Production scope, exact name, then redeploy again. Old key must be revoked at console.anthropic.com.
- Stripe: BOTH checkouts fail on live (homeowner /plus: flash "We couldn't start checkout"; /pro/plus: 500 until the rethrow fix ships). stripe.checkout.sessions.create throws with an identical digest on both cadences. Check Vercel Production: STRIPE_SECRET_KEY (live sk_live_), STRIPE_PRICE_PLUS_MONTHLY/_YEARLY and STRIPE_PRO_MONTHLY/_YEARLY_PRICE_ID (must be live-mode price ids matching that key), NEXT_PUBLIC_SITE_URL. Vercel function logs for the POST will show the real Stripe message.
- Landen reported "contractor page isn't working on phone" but has not said which URL; every contractor page probed at 390px rendered for the test accounts.

Code changes made this session (ALL UNCOMMITTED, on main working tree; verify with git status):
1. All of Orange County launch area: src/lib/serviceArea.ts (36 pickable cities = 34 incorporated + Ladera Ranch + Midway City; 91-ZIP map), migration 0129_all_orange_county.sql + PASTE-ME-live-2026-08-26-all-oc.sql, pro city picker (All of OC default + grouped disclosure), addressSuggest ZIP-gated, copy updated. Checker round done, fixes applied (92679 -> RSM, 92676 -> Orange, North Tustin/Rossmoor/Coto de Caza not pickable).
2. RentCast hardening: third source "unavailable" (never cached, never refuses, manual entry note) in parcel.ts/onboarding; home value headline = RentCast AVM with formula fallback capped at 2.5x purchase price, dashboard and /value share one chooser. Checker running.
3. IDOR sweep: server-action fixes in contractors/actions.ts (issue_id + photo_urls ownership), profile/actions.ts (attachPhotos, updateSystemAction), issues/actions.ts (system_id); test src/lib/ownershipChecks.test.ts. Checker B found DB-layer bypasses via raw PostgREST: photos.url unbound, contractor_leads.issue_id unchecked on INSERT, /api/draft-apply admin read, get_or_create_wallet grant. Hacker A is writing migration 0131 + PASTE-ME for those; B's failing tests in src/lib/photoUrlDbBinding.test.ts are the acceptance criteria.
4. Trial-abuse risk score: migration 0130_account_risk.sql + PASTE-ME-live-2026-08-26-account-risk.sql, src/lib/risk/*, device cookie in middleware, fingerprint component on signin/signup, signals at signup/claim/company save/checkout/webhook, trialDecision in both checkouts (medium = no trial, high = refuse), pro checkout no longer rethrows, privacy copy corrected (it used to claim no IP/fingerprint storage). NEW ENV: RISK_HASH_SALT (set in Vercel before the paste runs; never rotate). Checker B running. Open questions for Landen in the A report: medium silent or told; high refuse vs no-trial + alert; admin page.
5. Side switch: pending state on the menu item ("Switching to your business..."), Home/Business pill in the header for dual accounts (server-rendered), weather strip fix (skeleton was gated on a per-document pageLoaded flag that never resets on client nav). Files: ProfileMenu.tsx, Nav.tsx, ProNav.tsx, SidePill.tsx, WeatherStrip.tsx + tests.
6. Loading states: audit done (SubmitButton lacks a synchronous double-submit guard = the double-save; CRM Track and household Decline buttons plain; ask/pro-ask/plus/pro-plus/p/[id] lack page-shaped loading.tsx). Fix worker running.
7. Post job tap swallowed (CONFIRMED live): with the description textarea focused, tapping Post job blurs the textarea, something re-lays out, mouseup lands on the StrongPostMeter and the click goes to the form, not the button. Fix worker running (make the region above the button layout-stable).

Test data created 08-26 (cleanup with the accounts): homes on test-1 (9063 Warner Ave), test-2 (17816 Bushard St, display name corrupted to "Bushard Fountain Valley" by the editable confirm step, see below), test-5 (16400 Brookhurst St); TWO jobs "TEST (ignore) leaky faucet" under test-1 (created by the probe); pro companies on test-3/4/5; CRM lead on test-3.

Also found, not yet fixed: confirm step lets the street be edited to garbage and saves it as the display address without re-lookup (T2b); "unverified" ownership never explained after claiming; junk contractor "2e3thyj" visible in Browse Pros on live (delete via SQL); forecast page leads with a big number before admitting missing data; autocomplete needs the city typed; pro wizard accepts junk custom category on the step (server rejects at Finish); CRM add-client has no phone field and its note does not show in the detail timeline; hydration error #418 seen once on /dashboard.

## RESUME HERE (written 2026-08-26 at wrap-up; Landen had to leave)

State: 56 modified + 27 new files in the working tree, NOTHING committed or pushed. Last full green run (before the final two agent rounds): tsc 0, vitest 52 files / 721 tests, eslint 0 errors (3 pre-existing img warnings). No production build run since the OC change's isolated build (exit 0).

All agents finished. FABLE VERIFIED 2026-08-26 after the last round: tsc 0, vitest 55 files / 777 tests, eslint 0 errors (3 pre-existing img warnings), isolated production build exit 0 (tsconfig restored, .next-verify removed). Migrations 0130 and 0131 reviewed by Fable; 0129 ZIP map spot-checked (91 ZIPs / 36 cities). READY FOR COMMIT once Landen says so.
- Risk score round 2: DONE (all 12 applied, adversarial tests flipped to fixed behavior, RISK_ENFORCE log-only default, high = no trial + log, risk_overrides table, salt required). Items were: card re-check in the webhook with trial_end=now, exclusive age/onboarding weights, household exemption, trial_abuse no longer feeds +40, 7-day IP window + ORDER BY in linked_accounts, fingerprint decoupled and hashed with device id, cardSharedWithOther 40, trialDecision before recordRequestSignals, corroborated trial_abuse flag, logging, cookie skip on metadata routes + try/catch, RISK_HASH_SALT hard requirement + salt_version column, risk_overrides table, RISK_ENFORCE flag defaulting to false = log-only mode, high = no trial + alert, never refuse). Files: src/lib/risk/**, both plus actions, webhook, middleware/cookies, 0130 + its PASTE-ME. src/lib/risk/adversarial.test.ts holds B's characterization tests that must be flipped to the fixed behavior.
- Post job tap fix round 2: DONE. Root cause src/components/PhotoTips.tsx: it read the category on a form "change" listener, but the category lives in a React-set hidden input that fires no native event, so the tips block (130px) only mounted when the description textarea blurred. Fixed (deferred read after change + debounced input listener), test PhotoTipsMountTiming.test.tsx; contractors folder tests 11/11, tsc 0.

FIRST STEPS NEXT SESSION
1. git status; then npx tsc --noEmit; npx vitest run; npx eslint src; NEXT_DIST_DIR=.next-verify npx next build (restore tsconfig.json include if the build appends .next-verify types). Fix anything red (most likely src/lib/risk/*.test.ts if round 2 was cut off mid-edit).
2. Read the final reports of the two agents above if available; otherwise diff src/lib/risk and src/app/(app)/contractors against the lists above and finish what is missing.
3. Fable review pass of: 0129 (ZIP map spot-checked OK: 91 ZIPs, 36 cities), 0130 (risk tables), 0131 (photos trigger, lead INSERT check, job-photo gates, wallet grants). None of the three SQL files has been executed anywhere; each PASTE-ME has verify queries.
4. Then ask Landen for the commit/push go-ahead (never assume it).

OWNER REMINDERS (Landen asked to be reminded)
- Ask Hearth is DOWN on live: ANTHROPIC_API_KEY not reaching the Production deployment. Check scope = Production, exact name, redeploy, test /ask. Revoke the old key.
- Stripe: BOTH checkouts fail on live. Check STRIPE_SECRET_KEY + the 4 price ids are live-mode from one account, NEXT_PUBLIC_SITE_URL set; Vercel function logs show the real error.
- Before running the account-risk paste: set RISK_HASH_SALT in Vercel (random 32+ chars, never rotate). Keep RISK_ENFORCE unset (log-only) for the first week.
- Live DB pastes ready, in order: PASTE-ME-live-2026-08-26-all-oc.sql, PASTE-ME-live-2026-08-26-db-ownership.sql, PASTE-ME-live-2026-08-26-account-risk.sql (each with verify queries). Run only after the matching code is deployed.
- Cleanup SQL: delete from auth.users where email like 'hearth-test-%@example.com'; (cascades homes, companies, CRM lead, the two "TEST (ignore) leaky faucet" jobs). Also delete the junk contractor "2e3thyj" (select first).
- Still unanswered: which contractor page is broken on Landen's phone (URL + what it shows).

## Red-team pass 2026-08-26 (pre-commit): what it found and what happened

Verdict: DB layer, cron auth, webhook signatures, redirects, PII logging all solid. Real risks were operational fail-open and unvalidated outbound. FIXED in the same commit (agents X and Y): Stripe webhook fails closed on a missing secret and credits amount_total not metadata; SMS destination validated US/CA E.164 at the send door; CR/LF stripped from titles in email/SMS; OUTBOUND_DISABLED kill switch + per-minute cap; AI global gate refunds the user's bump and paying users skip the daily owner-wide gate; job-post RentCast re-check metered; address-suggest global cap; migration 0132 (contractors column CHECKs for logo_url/contact_phone/name/about/review URLs, lead_previews revoked from authenticated, has_open_chargeback gate in apply_to_lead + unlock_direct_request, review gates: terminal status + no card/email/phone link between reviewer and pro); SSRF origin check on logo fetch; fold() for zero-width/homoglyph evasion in censor + custom category; company name and about moderated; password-reset update step needs a recovery cookie; password_set metadata no longer trusted; secure cookies; neutral signup message; public_pro_profile gated; stale setup.sql removed.

OWNER / OPS ITEMS (not code):
- Twilio console: Geo Permissions US + CA only, before TWILIO_* is set.
- Supabase Auth: enable "Secure password change" (re-auth required), enable CAPTCHA, tighten token/signup/recover rate limits.
- src/lib/notify.ts email footer still has "[TODO(legal): registered business address]" (CAN-SPAM). Needs a real address.
- CSP is Report-Only with no report-uri (blocks nothing). Decide on an enforced policy later.
- No per-account storage object cap; app_events has no prune. Follow-ups.
- Review COMMENT text is not moderated yet (SQL cannot run censor; the TS path is in contractors/actions.ts leave-review). Follow-up.

## MORNING ITEMS for Landen (found overnight 2026-08-26/27; both are yours, I could not do them)

1. STRIPE_SECRET_KEY in Vercel is a placeholder ("yoursk_t...ive"), which is why every checkout says "couldn't start checkout" (Vercel log: "Invalid API Key provided"). Fix: open C:\Users\lande\hearth\.env.local, copy the value after STRIPE_SECRET_KEY= (starts sk_test_51SQD6dDxdfZ..., 107 chars, the sandbox where the webhook was created), paste it into Vercel > hearth > Settings > Environment Variables > STRIPE_SECRET_KEY (Edit, Production + Preview), then Deployments > Redeploy. The four STRIPE_PRICE_* / STRIPE_PRO_*_PRICE_ID vars were deleted on purpose (they pointed at prices that do not exist in the sandbox; the app uses its built-in prices when they are absent).
2. Live DB is MISSING migrations 0130, 0131, 0132 (REST returns 404 for account_signals, account_risk, risk_overrides, has_open_chargeback; the Vercel log shows "Could not find the table public.account_signals"). 0129 may or may not be applied. The "SQL success" earlier was not the combined file. Re-run in the Supabase SQL editor: supabase/PRECHECK-2026-08-26.sql first (all six queries must return 0 rows), then supabase/COMBINED-2026-08-26-migrations-0129-0132.sql. Verify after: select public.launch_city_for_zip('92694'); select count(*) from account_signals; select proname from pg_proc where proname = 'has_open_chargeback';

## Overnight 2026-08-26/27 outcome (written 08:20)

Pushed: 0774510 (sign-in landing fix, Plus simplification, sign-up button) and fb36deb (dashboard declutter + one-number cards, weather F/C, RentCast label gone, WEEKLY Plus plan at $1.99 with the 3-day trial moved to weekly, monthly $4.99 preselected, review prompt + /feedback + migration 0133, Add-to-Home-Screen nudge, Tools bottom sheet, pro card density, privacy/AI docs). Each push was preceded by tsc, full vitest (1051), eslint, isolated build, and a checker agent.
Did NOT run overnight: the iPhone test cycle and the red-team pass (the session idled after the last checker; no wake-up loop was scheduled). Both were launched at 08:15 when Landen returned.
STILL OWNER ITEMS: STRIPE_SECRET_KEY placeholder in Vercel (checkout fails on both sides), live DB missing 0130-0133 (PRECHECK then COMBINED then app-feedback paste), STRIPE_PRICE_PLUS_WEEKLY optional (inline price works), NEXT_PUBLIC_APP_STORE_URL optional for the rate button, delete hearth-test accounts when done.
Lesson for next time: for an overnight cycle, use the /loop skill with a wake-up so the fix-test loop continues without a user message.

## Red team pass 2 (2026-08-27 morning, on 0774510 + fb36deb)
Found: BLOCKER open redirect via the inner ?next= in destinationForSignIn (OAuth/magic-link only; backslash and tab bytes decoded after safeNextPath) -> being fixed; feedback writes had no rate limit (arms when 0133 is applied) -> being fixed with limits + unique index; /plus ran ~10 service-role queries per view for existing members -> being fixed; ReviewPrompt re-queried on every navigation forever -> being fixed; Plus trial eligibility failed OPEN on a DB read error -> isPlusTrialEligible added; two live subscriptions possible for a brand-new buyer in two tabs -> guard added; fold() bypasses (combining marks, tag chars, RTL override, Armenian o) -> being fixed; pro profile buttons lacked the double-tap latch -> being fixed; 11 AI routes never refunded usage on model failure -> being fixed; review-prompt exclusion list typo -> fixed.
DECISION FOR LANDEN (not code): weekly $1.99 with a 3-day trial gives a trialing account the Plus AI ceiling (15 asks/day, 250 model calls/day) for free, and RISK_ENFORCE is off, so a farmer can burn ~750 model calls per throwaway account and 20 such accounts empty the global daily AI budget. Options: (a) set RISK_ENFORCE=true in Vercel once the risk tables exist and a week of log-only data looks sane; (b) cap trialing accounts at the free-tier AI limits until the first paid invoice; (c) both. Recommend (c).
Also noted, not fixed: open_jobs_for_me has no LIMIT (scale issue); review comments still unmoderated.

## 2026-08-27 morning wave: pushed 963593b + 30048de
Red team 2 fixes (open redirect via inner ?next=, feedback rate limits + unique index, Plus trial fails closed, double-checkout guard both sides, fold() hardening, AI refunds on thrown model calls in 11 routes, pro profile double-tap latch, /plus risk query only for non-members, ReviewPrompt settled flag) and iPhone tester fixes (Tools sheet stacking, open-jobs anchor, energy card in-place details, posted-job banner scrolls into view, Plus picker preselects Weekly when a trial exists, nudge z-order and 44px targets, pro profile no longer blanks after Save, /pro/plus one checkout button, checklist tap padding). Verified: tsc, 79 files / 1149 tests, eslint, isolated build, checker.
Process note: 963593b was pushed with one red test because a piped grep hid vitest's exit code; 30048de fixed it two minutes later. Always capture vitest's own exit code before a push.
STILL YOURS: STRIPE_SECRET_KEY placeholder in Vercel; live DB missing 0130-0133 (PRECHECK, COMBINED, then app-feedback paste); decide RISK_ENFORCE / trial AI caps for the weekly plan; delete hearth-test accounts (their jobs, CRM clients and profile edits are all titled TEST (ignore)).

## Live post-deploy smoke (2026-08-27 ~09:55) + latency finding
Public pages all 200 (/, /pricing, /privacy, /ai-disclosure, /signin, both signups, /pros, /fountain-valley); no em dashes. Password sign-in works (Supabase returns the token, cookies set: hearth_did httpOnly, hearth_fp, sb-...-auth-token).
FINDING (not a push blocker, investigate): signed-in server pages are slow on cold start. Dashboard measured 67s cold -> 34s -> 13s warming, /value ~6s, /forecast ~7s. All return 200, no 5xx, no fatal logs. Cause is hobby-tier serverless cold starts PLUS heavy sequential Supabase queries per page, several of which hit the not-yet-created risk/feedback tables (account_signals, account_risk, risk_overrides, linked_accounts, app_feedback all 404 and log an error each). Running the DB pastes removes those errored round trips and should cut dashboard latency. If it is still slow after the migrations: parallelize the dashboard's Supabase queries (they look sequential), cache trialDecision, and consider the Vercel Pro plan for warm functions. Do NOT chase this before the migrations are applied; it is confounded by them.

## Overnight 2026-08-28/29 (Claude, with Landen's one-night push permission)

Read STATUS.md first (morning list). Pushes: d2b30a2 (wave 1), 29f5231 (round 2), plus a round-3 push (see git log). Each push: tsc 0, full vitest green, eslint 0, isolated build 0, red team (2 agents) + checker, Fable review.

Process: research agents (paywall x3, speed, App Store, operations, a11y/copy, mobile home) -> Fable plan -> 30+ sonnet/opus workers -> 2 red teams -> checker -> push -> 10 persona testers (dev server by accident: a leftover `next dev` was on :3100; findings still valid, perf/dev-indicator items discarded) -> bias checker -> fix waves -> push -> 5 testers on a real `next start` build -> fixes -> push -> 10 checker agents.

Root causes worth remembering:
- Leads list empty everywhere since 0105 added `direct_to` (second FK to contractors): PostgREST PGRST201 ambiguous embed, error swallowed; fixed with `contractors!contractor_leads_contractor_id_fkey` via src/lib/leadJoin.ts. This is why "posted job vanished" showed up in 3 tester reports.
- RentCast answers a miss with HTTP 404; the code treated every non-ok as "unavailable" (never cached, re-billed, fake-address gate unreachable). Now 404 = miss, retry on connect failure, body read bounded; a miss proceeds to manual entry (product call).
- Photon substitutes the nearest house number; now filtered when the query has a number.
- Ask Hearth transcript: `messagesRef.current = messages` in the render body could roll the list backwards; removed; answers saved while streaming; storage quota handled.
- Dual-role unread badge counted the account's own outgoing business messages (RLS lets either party read the lead).
- Live DB constraint `contractors_launch_cities_subset` still pre-0129 (HB + FV only) until Landen pastes 0129-0132; every pro tester hit it.
- Aborting a stream refunded the question (unlimited free tier); `public.users` had no column lock (counters resettable via PostgREST); both fixed (askStream `gone` flag, 0139 trigger).

Scratchpad (session 99a39419): paywall-inventory/benchmarks/ux.md, speed-plan.md, appstore-checklist.md, operating-plan.md, a11y-copy-audit.md, mobile-home-plan.md, redteam-A/B.md, persona-run/round1-findings.md + round1-bias-check.md, README-round2.md, shots/.

Owner items are in STATUS.md. Test accounts to delete: hearth-persona-* (round 1: h1-h4, c1-c4, d1, d2, d2b; round 2: r2h1, r2c2; plus hearth-persona-0), hearth-test-1..5@example.com, hearth-redteam-*.

### Round 4 (final 10-checker pass, 2026-08-28 early morning)

Ten checker agents read the whole overnight diff after round 3. Their findings went to five workers, then the same gate (tsc 0, full vitest 0, eslint 0, isolated build 0). Commit: see STATUS.md item 4.

What they caught and what changed:
- Claim path trusted hidden parcel fields from the form; server now re-derives them.
- Ask Hearth: clearing a chat while an answer streamed let the answer come back (generation counter now stales it); a clear in one tab did not clear the other (storage listener); an empty model reply spent a question without a refund (refund + idempotent refundOnce); abort refunds capped at 5/hour per user; pro Ask photo answers are Pro-only; trial accounts see "your 8 questions for today" instead of a Plus upsell.
- Payments: the trial is reserved (claim_promo "plus_trial") before the Stripe session is created and released if checkout expires, so two tabs cannot start two trials; customer.subscription.updated can no longer resurrect a canceled row; free/Plus/trial numbers come from constants (drift test); dunning notice ids fall back when invoice.id is missing; the /plus decision cache only holds "charged today" decisions (a cached "3 days free" could go stale against a checkout that bills today).
- Desktop header: HomeSwitcher could not shrink (sm:min-w-[auto]) so the address collided with Home / Browse Pros at every width. Now truncates; probe clean at 1024 to 1920. 640-1023 still collides (pre-existing, structural, see STATUS.md).
- Phone: job-card Edit/Close are 44px, the posted banner scrolls clear of the header (scroll-mt was on the wrong element), the tip box shows once, app guide snoozes for the tab after a route change instead of re-opening.
- 0140: unlock_direct_request checks user_blocks, reason length cap, named unique index.

Probe scripts: scratchpad/hdr/probe.js (header pair intersections per width), budget.js.
Not done: 640-1023 header shell decision; RISK_ENFORCE is still off (log-only), so the decision cache does nothing until it is turned on.

## Wave 2026-08-29/30 (overnight)

### Goals
Everything Landen asked for on the evening of 2026-08-29: iMessage-style phone composer, Ask Hearth only in Messages, plan parity, checkout bug, pro Home/Leads split with retention hooks and paywall parity, feedback credit, owner name, push notifications, rating prompt, eyesight pass, thank-you pages, share images, breadcrumbs, analytics, and the security checklist.

### Current state
All of it is in this commit, gate green (tsc 0, eslint 0, vitest 178 files / 2463, build 0), two verifiers (V1 security: blockers fixed; V2 regression: PUSH yes). Not active on live until the owner pastes the SQL bundle and sets the VAPID env.

### Files touched
About 320 paths (183 modified, about 110 new): src/components (AskHearth, LeadChat, PhoneChatFrame, NotificationBell, Push*, Breadcrumbs, RememberedDetails, ReviewPrompt, ProNudge, ProChip, ProTrialNudge), src/lib (useVisualViewport, askLock, csrf, sessionActivity, logSafe, uploadGuard, envGuard, push*, trackServer, checkoutReservation, checkoutIdempotency, promoClaimRef, proHome*, proFeedback*, nativeReview, reviewPrompt), pro pages (page = Home, leads/, feedback/, plus, billing, chats, onboarding, profile), homeowner pages (plus, dashboard, chats, ask, account/*, contact/thanks, guides OG), api routes (push/subscribe, pro-tools, pro-ask, ask, stripe webhook, pro-compliance), migrations 0141-0146 + PASTE-ME files + PASTE-ME-ALL-PENDING-2026-08-30.sql, docs (SECURITY-OPS, ENVIRONMENTS, BACKUPS-AND-RESTORE, ANALYTICS, GO-LIVE-WIRING), public/sw.js.

### What changed
See STATUS.md "Wave 2026-08-29/30" for the product list. Review fixes applied by the lead after the verifiers: env guard test-Stripe warn-only (REQUIRE_LIVE_STRIPE=1 makes it fatal), idle sign-out scope local, free drafts fail closed without 0145, license unlock via admin client (0069 allowlist), owner_name in CONTRACTOR_COLUMNS, push upsert via admin client (shared device takeover), webhook rollback also releases session-scoped reservations, owner-name hint says it is public, feedback credit capped at $5 inside SQL.

### What failed
Nothing in the gate. Not verifiable without a device or live keys: real iOS keyboard behaviour, real push delivery, Twilio SMS, realtime filters at volume, 0141-0146 on a real database. Known deviations: /search still has inline Ask panes; LeadsRealtime no longer live-refreshes on competing applications (poll covers it); pro texts go to users.phone.

### Next steps
1. Owner: SQL bundle, VAPID env + redeploy, Supabase Auth settings, RLS audit results, plan/backups check, /api/health firewall rule, environments split, Apple key rotation.
2. Live checks (5 agents), 10-persona click-everything wave, red team incl. Ask Hearth and account break-ins, fix loop, then the CEO-level product pass.
3. Hardening queue: server upload route for the 7 direct-to-storage uploads; convert 3 own-row admin reads; pro-logos bucket privacy; lead_quotes/invoices realtime publication; breadcrumbs on pro/profile, pro/billing, pro/crm/[id].
