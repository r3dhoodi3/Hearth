# Hearth handoff (2026-08-24)

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
