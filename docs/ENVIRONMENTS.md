# Staging and production must not share credentials

Owner: Landen. This is a configuration job, done in three dashboards. There is
one piece of code behind it (`src/lib/envGuard.ts`) and it only exists to catch
the mistakes this document is about.

## The problem, stated plainly

Today Vercel Preview and Vercel Production run on the **same credentials**.
`STATUS.md` records that `ANTHROPIC_API_KEY`, `RISK_HASH_SALT` and
`STRIPE_SECRET_KEY` were set as team **shared** environment variables linked to
the Hearth project, and `docs/GO-LIVE-WIRING.md` tells you to set the Supabase
variables on "Production, Preview and Development". So every preview deploy -
every branch, every pull request, including one from a contributor you have
never met - holds:

- the service-role Supabase key, which ignores every row-security policy and
  can read and delete every customer's data,
- the Stripe secret key,
- `RISK_HASH_SALT`, the secret that keeps the abuse-signal table from being a
  reversible list of everybody's IP addresses and phone numbers,
- the Anthropic key, which spends real money per call.

That means a leaked or careless preview deploy is a leaked production database.
It also means anything you do while testing a branch happens to **live customer
rows**: a script that seeds test data, a migration you try out, a cron you
trigger by hand.

What follows fixes it. Roughly two hours of clicking, once.

---

## Step 1: a second Supabase project

1. supabase.com/dashboard -> **New project**.
   - Organisation: the same one as the live project.
   - Name: **`hearth-staging`**.
   - Database password: generate, save to your password manager.
   - Region: same as live.
   - Plan: Free is fine. Staging has no customers, and a project that pauses
     when idle is not a problem here.
2. When it finishes, go to **Project Settings -> API** and copy three values
   into a scratch note (you will paste them into Vercel in step 4):
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **anon public** key
   - **service_role** key
3. **Load the schema.** SQL Editor -> New query. Paste and run, in order:
   - every file in `supabase/migrations/` in filename order, or
   - the combined pastes if that is easier: the `supabase/PASTE-ME-*.sql` files
     in numeric order. `supabase/MIGRATIONS.md` has the current apply order.

   Run them one at a time and read each result. This is also a free rehearsal
   of the migration order for the day you do it on the live project.
4. **Do not copy customer data into it.** Staging with real data is production
   with a worse password. Sign up two or three test accounts by hand instead.
5. **Auth settings** (Authentication -> URL Configuration): Site URL is the
   Vercel preview URL, redirect allowlist `https://*.vercel.app/**` plus
   `http://localhost:3000/**`.

## Step 2: Stripe test mode

You already have this; it just needs to stop being shared with Production.

1. dashboard.stripe.com, toggle **Test mode** on (top right).
2. Developers -> API keys -> copy the **Secret key** (`sk_test_...`).
3. Still in test mode, Products: re-create the Hearth Plus and pro membership
   prices so there are test-mode price ids. Copy each price id.
4. Developers -> Webhooks: add an endpoint pointing at your preview URL
   (`https://<preview>.vercel.app/api/stripe/webhook`), same event list as live,
   and copy its **signing secret** (`whsec_...`). It is a different secret from
   the live one.

## Step 3: separate secrets for everything else

These are not shared between environments either. Generate a NEW value for each,
do not reuse the production one.

| Variable | How to make a Preview value |
| --- | --- |
| `RISK_HASH_SALT` | A fresh random string. Run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Note: staging hashes will not match production hashes, which is the point. |
| `VAPID_PRIVATE_KEY` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `npx web-push generate-vapid-keys` gives a fresh pair. Push subscriptions are per key pair, so staging cannot push to a real user's phone. |
| `ANTHROPIC_API_KEY` | console.anthropic.com -> Settings -> API keys -> Create key, named `hearth-preview`, with its own low spend limit. A runaway loop on a branch then costs $5, not the month's budget. |
| `SUPABASE_SERVICE_ROLE_KEY` | The staging project's service_role key from step 1. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The staging project's, from step 1. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / the price ids | The test-mode values from step 2. |
| `RESEND_API_KEY` | Leave it UNSET on Preview. With no key, no email goes out. That is the right default for a branch deploy. |
| `TWILIO_*` | Leave UNSET on Preview, same reason. |
| `OUTBOUND_DISABLED` | Set to `1` on Preview as a belt-and-braces second stop (`docs/GO-LIVE-WIRING.md` section 9). |
| `STAGING_SUPABASE_URL` | The staging project URL, set on **both** Production and Preview. This is what `src/lib/envGuard.ts` compares against; without it the guard cannot know which project is staging. |

## Step 4: scope every variable in Vercel

This is the step that actually separates the two, and the one that is easy to
get half-right.

1. vercel.com -> the `hearth` project -> **Settings** -> **Environment
   Variables**.
2. **First, deal with the shared ones.** Variables set at the team level show up
   on the **Shared** tab, not in the project list, and `npx vercel env ls` does
   not show them at all (`STATUS.md` notes this). `ANTHROPIC_API_KEY`,
   `RISK_HASH_SALT` and `STRIPE_SECRET_KEY` are currently shared. For each:
   unlink it from the `hearth` project, then add it back as a **project**
   variable so it can be scoped per environment. A shared variable cannot be
   different per environment, which is the whole problem.
3. For every variable in the list, click **Edit** and set the environment
   checkboxes deliberately:
   - **Production only:** live Supabase URL/keys, live Stripe keys and price
     ids, live `RESEND_API_KEY`, `TWILIO_*`, production `RISK_HASH_SALT`,
     production `VAPID_*`, production `ANTHROPIC_API_KEY`,
     `NEXT_PUBLIC_SITE_URL`.
   - **Preview only:** every staging/test value from steps 1 to 3.
   - **Both:** `STAGING_SUPABASE_URL` (the guard needs it on both sides),
     `NEXT_PUBLIC_APPLE_SIGNIN`, `NEXT_PUBLIC_APP_STORE_URL`.
   - **Development:** leave alone; that is your `.env.local`, which this
     document does not touch.
4. Mark every secret **Sensitive** so it cannot be read back out of the UI.
5. **Redeploy both.** Environment variables are baked in at build time for
   anything `NEXT_PUBLIC_`; an unredeployed Preview keeps the old values.

## Step 5: prove it

Two checks, five minutes.

1. Open a preview deploy, sign up a new account, and confirm the account appears
   in the **staging** Supabase project's Authentication -> Users, and NOT in the
   live one.
2. Start a checkout on the preview deploy and confirm the session shows up in
   Stripe's **test mode** dashboard, not live mode.

If either lands on the production side, one variable is still scoped to both.

---

## The code guard behind this

`src/lib/envGuard.ts`. It exists because the steps above are done by hand in a
web UI, and the two ways they go wrong are both silent:

- **Production pointed at staging.** The staging database answers queries
  perfectly happily. Nothing errors. Real users read and write staging rows and
  nobody notices until someone asks where their data went.
- **Production still on a test Stripe key.** Checkout completes, Stripe returns
  success, the subscription is created in test mode, and no money is ever taken.
  Everything looks like it worked.

So the guard checks exactly those two things, and only when `VERCEL_ENV` is
`production`:

- `NEXT_PUBLIC_SUPABASE_URL` resolves to the same project ref as
  `STAGING_SUPABASE_URL` (or `STAGING_SUPABASE_PROJECT_REF`) -> refuse.
- `STRIPE_SECRET_KEY` starts with `sk_test_` -> refuse.

It runs at the first use of each credential (`createAdminClient()` in
`src/lib/supabase/admin.ts`, `getStripe()` in `src/lib/stripe.ts`), not at
import time, so a correctly wired deploy never pays for it and a build never
fails on an unrelated page. It logs a `[ALERT] env separation:` line before it
throws, so the reason is in the Vercel runtime logs even if a caller swallows
the exception. Tests: `src/lib/envGuard.test.ts`.

Preview is explicitly exempt: test keys and the staging project are exactly what
belongs there.

---

## Malware scanning, since it lands in the same budget conversation

`src/lib/uploadGuard.ts` has a `scanForMalware(buffer)` hook that returns
`"unscanned"` today and is already awaited by the upload path, so switching it
on is one function body and one environment variable
(`MALWARE_SCAN_PROVIDER`). There is no ClamAV on Vercel: the runtime is
short-lived and a virus database is hundreds of megabytes to download per cold
start. The two realistic options:

| Option | Cost | Effort | Notes |
| --- | --- | --- | --- |
| **Scanning API** (Cloudmersive, VirusTotal, Attachment Scanner) | Cloudmersive has a free tier around 800 calls/month, then roughly $0.001-0.01 per file. VirusTotal's free tier is 4 requests/minute and its terms do not allow commercial use, so it is fine for testing and not for production. | An afternoon: a key, one `fetch` in `scanForMalware`, a timeout, and a decision about what to do when the API is down (fail open and log, or fail closed and refuse the upload). | Adds a network round trip to every upload. Sends customer documents to a third party, which belongs in the privacy policy. |
| **Supabase Edge Function running ClamAV** | No per-file cost. The container is bigger and slower to cold-start; on the Supabase Pro plan it is included in the compute you already pay for. | A day or two: build the function, keep `freshclam` updating the definitions, handle the cold-start latency. | Nothing leaves Supabase. This is the better answer once there is enough upload volume to justify it. |

**Recommendation:** stay on `"unscanned"` until there are paying customers, then
take the scanning API for the speed of it, and only build the Edge Function if
per-file cost or the third-party data-sharing becomes the objection. What is
already in place without either of them: a byte-size cap the server enforces,
magic-byte type checking so a renamed file cannot get in, a refusal of PDFs
carrying `/JavaScript` or `/OpenAction`, and EXIF plus appended-payload
stripping on every stored image.

## REQUIRE_LIVE_STRIPE (added 2026-08-29)

Until real customers pay, the live site runs Stripe in test mode on purpose, so `src/lib/envGuard.ts` only logs an `[ALERT]` for an `sk_test_` key on Production. When you switch to the live key, also set `REQUIRE_LIVE_STRIPE=1` on Production: from then on a test key on Production is fatal at the first Stripe call, the same way a staging database is.
