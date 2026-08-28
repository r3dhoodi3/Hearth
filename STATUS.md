# Hearth status (2026-08-27)

Quick-read handoff so the chat can be cleared. Full blow-by-blow detail is in `HANDOFF.md`.
Live site: https://gethearth.vercel.app (old link https://hearth-seven-pink.vercel.app still works).
Code: all on `main`, pushed through commit `30048de`.

## What I want to do (goals)

- Ship Hearth mainly as an iPhone App Store app. The phone experience is what matters; desktop just has to not break.
- Make it feel like a simple home app anyone can use (Angi-style: few buttons, little scrolling, not "a whole assignment"), while keeping every standout feature: Ask Hearth, home health score, systems inventory, cost forecast, weather alerts, job posting with pro applicants, the pro leads board, CRM, wallet.
- Serve all of Orange County (done), with honest pricing and a clean subscription page.
- Keep it safe: never trust IDs from the browser, verify ownership on every request, block trial farming, moderate public text.

## Current status

- All of Orange County is live (36 cities, address suggestions gated to OC).
- Weekly / Monthly / Annual / Free Plus plans live. Monthly $4.99 (preselected), Weekly $1.99 with the only 3-day trial, Annual best value. One checkout button, plan cards select with the outline following, consent text next to the button.
- Dashboard decluttered: one number per card, tasks behind one tap, weather has an F/C toggle, no "RentCast" wording in the UI.
- Review prompt ("Enjoying Hearth?" -> Love it = rate step, Not really = private /feedback form), Add-to-Home-Screen nudge, Tools bottom sheet, denser pro leads cards.
- Security waves done: IDOR fixes (app + DB), trial-abuse risk score (log-only for now), red-team hardening x2 (open redirect closed, webhook fail-closed, moderation folding, rate limits, AI refunds).
- Every push was verified: tsc clean, ~1149 tests, eslint 0 errors, isolated production build exit 0, plus a checker agent.

## Next steps (mine, in order)

1. Vercel: set `STRIPE_SECRET_KEY` to the real value from `.env.local` (currently a placeholder, so checkout fails), then Redeploy. This unblocks all payments.
2. Supabase SQL editor, in order: `supabase/PRECHECK-2026-08-26.sql` (all queries must return nothing), then `supabase/COMBINED-2026-08-26-migrations-0129-0132.sql`, then `supabase/PASTE-ME-live-2026-08-27-app-feedback.sql`. This creates the risk + feedback tables and should also speed up signed-in pages.
3. Decide trial-farming controls for the weekly plan (see Notes): set `RISK_ENFORCE=true` in Vercel after a week of log-only data, and cap trialing accounts at free-tier AI limits.
4. Delete the test accounts when done: `delete from auth.users where email like 'hearth-test-%@example.com';` (everything they made is titled "TEST (ignore)").
5. Supabase Auth > URL Configuration: set Site URL to https://gethearth.vercel.app and add https://gethearth.vercel.app/** to Redirect URLs (so email and Google/Apple sign-in point at the new name).

## Next steps (product, when I want them)

- Onboarding slides for first login, one version for homeowners and one for contractors (after account creation, not on the landing page).
- Keep pushing the "simple app, not a website" feel: header shows title + avatar only, sheet-style detail pages, a real App Store app via a Capacitor wrapper (needed for push notifications, haptics, and a native review prompt).
- A home-details editor (year built / sqft / beds / baths have no post-onboarding form yet).
- Ask Hearth streaming (answers still take ~10s).

## What worked

- Probing the live site directly caught real config problems a code review could not (the wrong service-role key, the placeholder Stripe key, missing migrations).
- Green-before-push discipline: tsc + full tests + eslint + an isolated build + a checker agent before every commit.
- Worker-agent then checker-agent then Fable review caught real bugs each round (the sign-in "too many homes" wall, the Post-job tap being swallowed, an open redirect, moderation bypasses).
- Address claiming, Ask Hearth, all-of-OC suggestions, the plan picker, moderation (accepts real surnames, rejects slurs and phone numbers), and the Post-job-while-typing fix all verified working on the live site.

## What did not work / went wrong

- Checkout still fails on live because the Vercel `STRIPE_SECRET_KEY` is a placeholder (`yoursk_t...`). Not a code bug; env config. Fix in Next step 1.
- The risk and feedback tables do not exist on live yet (migrations 0130-0133 not applied), so those queries error on every signed-in page load and log noise. Fix in Next step 2.
- Signed-in pages are slow on cold start (dashboard ~67s cold, warming to ~13s, other pages ~6-7s). Pages return 200, no crashes. Caused by hobby-tier serverless cold starts plus heavy sequential DB queries, several hitting the missing tables. Applying the migrations should help; if still slow, parallelize the dashboard queries and consider Vercel Pro.
- One push (`963593b`) briefly went out with a single red test because a piped `grep` hid the test runner's exit code; fixed two minutes later in `30048de`. Lesson recorded: always capture the real exit code before pushing.

## RISK_ENFORCE and trial AI caps (trial-farming control)

This is the one guard that stops people abusing the free trial on the new $1.99 weekly plan. Read before turning the weekly plan loose.

- The problem: a trialing account currently gets the full Plus AI ceiling (15 asks/day, up to 250 model calls/day) for free. Weekly is the cheapest way in, so a farmer could burn ~750 Anthropic calls per throwaway account, and ~20 accounts empty the whole daily AI budget for every real user.
- `RISK_ENFORCE` is a Vercel env var, currently UNSET (= off). The abuse score already runs and logs on every checkout, but with it off it never actually blocks anyone.
- Set `RISK_ENFORCE=true` to switch that score from log-only to real enforcement: medium score = no free trial (billed day one), high = no trial + an alert to me. It never refuses a sale.
- Second, separate lever: cap trialing accounts at the free-tier AI limits until their first paid invoice.
- Recommended order: (1) apply the DB migrations so the risk tables exist, (2) watch the score log for about a week, (3) then set `RISK_ENFORCE=true` in Vercel AND cap trialing AI. Do both, not one.

## Notes
- Optional Vercel env still unset: `STRIPE_PRICE_PLUS_WEEKLY` (weekly works via an inline price without it), `NEXT_PUBLIC_APP_STORE_URL` (hides the "Rate on the App Store" button until there is an app), `TWILIO_*` (SMS stays off), `CRON_SECRET` and `RESEND_*` (scheduled jobs and email off).
- Working agreements: no em dashes anywhere; commit and push only on an in-the-moment go-ahead (an overnight exception was granted 2026-08-26 and has ended); live DB changes ship as PASTE-ME files; mobile-first, verify at 390px, desktop must not break.
- Still open, not yet built: review comment text is not moderated; `open_jobs_for_me` has no LIMIT (a scale concern); the DMCA agent and a real business address are placeholders in the legal docs.
