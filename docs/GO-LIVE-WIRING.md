# Go-live wiring guide

Written 2026-08-09. The proactive layer (crons, email, SMS) is fully built and code-complete
on `feature/2026-07-19-app-update`. Nothing below needs code changes: it is all vendor
dashboards and environment variables. Until these are set, every cron 401s by design
(fail-closed) and email/SMS helpers no-op.

Work through the sections in order. Each ends with a "verify it worked" step.

## 1. Crons (unlocks the whole proactive layer)

All 17 cron routes under `src/app/api/cron/` are registered with schedules in `vercel.json`
and share one fail-closed auth check.

1. In the Vercel project settings, add env var `CRON_SECRET`. Generate a long random value,
   for example: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Confirm the Vercel plan supports 17 scheduled cron jobs (Hobby caps daily crons; Pro is
   fine). If capped, upgrade or trim `vercel.json`.
3. Redeploy. Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`.
4. Verify: in Vercel's Cron tab, trigger one job manually and check the function log shows a
   200, not a 401.

## 2. Email (Resend)

The sending code in `src/lib/notify.ts` is real and dormant until keys exist.

1. Create a Resend account and verify your sending domain (add the DNS records Resend gives
   you; wait for "verified").
2. In Vercel, set `RESEND_API_KEY` and `RESEND_FROM` (must be an address on the verified
   domain, e.g. `Hearth <hello@yourdomain.com>`).
   Warning: if `RESEND_FROM` is left unset, the code falls back to Resend's sandbox sender,
   which only delivers to the account owner's inbox. Set both or neither.
3. Verify: trigger any email path (e.g. the review-request flow or a cron that sends digests)
   and confirm delivery to a real non-owner address. Failed sends now log status + body to
   the server logs, so check the Vercel function logs if nothing arrives.

## 3. SMS (Twilio)

Also real code in `src/lib/notify.ts`, dormant until configured. TCPA gates are already in
code: recipients need `sms_consent = true` and a phone on file, and sends only happen
8am to 9pm America/Los_Angeles.

1. Buy an SMS-capable Twilio number.
2. In Vercel, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
3. In the Twilio console, set the number's "A message comes in" webhook to
   `https://<your-domain>/api/twilio/inbound` (handles STOP/START/HELP compliance).
4. If the app ever sits behind a proxy that rewrites host headers, also set
   `TWILIO_WEBHOOK_URL` to the exact public webhook URL so signature verification keeps
   passing.
5. Verify: text STOP then START to the number from a test phone and confirm the consent flag
   flips in the DB; then trigger a consented send.

## 4. Stripe

Checkout and the webhook are code-complete with inline price fallbacks, so payments work
before any Products exist in the dashboard.

1. In Vercel, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (live-mode values).
2. In the Stripe dashboard, add a webhook endpoint pointing at
   `https://<your-domain>/api/stripe/webhook`, subscribed to at least:
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.refunded`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_succeeded`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Optional but recommended for clean reporting: create Products/Prices in Stripe and set
   `STRIPE_PRICE_PLUS_WEEKLY` (a week-interval Price, the cadence carrying the 3-day trial),
   `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY`, `STRIPE_PRO_MONTHLY_PRICE_ID`,
   `STRIPE_PRO_YEARLY_PRICE_ID`, `STRIPE_PRO_INTRO_COUPON_ID`. Without them, checkout uses
   inline price_data at the amounts in `src/lib/constants.ts`.
4. Verify: run one live-mode Plus checkout with a real card, confirm the webhook shows 200 in
   Stripe's dashboard and the subscription row appears in the DB, then refund yourself.

## 5. Background checks (Checkr)

1. Set `CHECKR_API_KEY` and `CHECKR_PACKAGE` in Vercel. The Checkr webhook route already
   verifies signatures.
2. Verify: start a background check from a test pro profile and watch the webhook log.

## 6. AI (Anthropic)

Every AI feature in the app (Ask Hearth, Ask Hearth for Pros, the quote analyzer,
document and inspection reading, the tax appeal letter, the insurance packet, job
drafting, and the pro back-office tools) calls Anthropic's Claude. Without the key
those routes return an error; the rest of the app is unaffected.

1. Create an Anthropic account at console.anthropic.com, add a payment method, and
   create an API key.
2. In Vercel, set `ANTHROPIC_API_KEY` (mark it Sensitive). It is required in
   Production; set it in Preview too if you want the AI features to work there.
3. `GEMINI_API_KEY` is no longer used by any code path. Delete it from Vercel and
   from any local `.env.local` so nobody mistakes it for a live dependency.
4. Set a spend limit in the Anthropic console. Ask Hearth already caps usage per
   user (3 questions a day on Free, 15 on Plus, plus a burst limit), but the spend
   limit is the backstop.
5. Verify: ask Ask Hearth one question in production and confirm an answer comes
   back, then check the request appears in the Anthropic console's usage view.

Privacy note for the record: Anthropic's paid API terms say API inputs and outputs
are not used to train its models by default, and Anthropic retains API data for up
to 30 days for trust and safety. That is what `/privacy` and `/ai-disclosure` state,
so if the plan or vendor ever changes, those two pages have to change with it.

## 7. Trial-abuse risk score (RISK_HASH_SALT, RISK_ENFORCE)

Both memberships give away a 3-day free trial with a card on file, and the only
thing stopping one person farming that forever with new emails is the score in
`src/lib/risk` (migration 0130). It stores nothing raw: every identifier is
salted and hashed first.

**`RISK_HASH_SALT` is a hard go-live blocker.** There is no fallback. Without
it the app records no signals at all, logs an error at boot and on first use,
and every account scores as clean forever.

1. Generate a long random string (`openssl rand -hex 32` or any password
   manager, 16+ characters) and add it to Vercel as `RISK_HASH_SALT` for
   Production, Preview and Development.
2. Run `supabase/PASTE-ME-live-2026-08-26-account-risk.sql` against the live
   database (creates `account_signals`, `account_risk`, `abuse_flags`,
   `risk_overrides` and `linked_accounts`, all service-role only). Its verify
   queries confirm RLS is on with no policies for `authenticated`.
3. NEVER change `RISK_HASH_SALT` after launch. The hashes are salted with it, so
   changing it makes every signal recorded before the change stop matching, and
   every repeat offender looks brand new again. `account_signals.salt_version`
   exists so that if it ever truly has to change, the rotation can be a
   migration rather than silent amnesia.

### Run it in log-only mode for the first week

`RISK_ENFORCE` defaults to **off**, and it should stay off at launch. Leave it
unset (or set it to anything other than `true`).

While it is off, every checkout still computes and STORES a score in
`account_risk`, but the free trial is always granted and nothing is refused. The
point is to find out what the score would have done to real customers before it
is allowed to do it. The saved queries at the bottom of the PASTE-ME file are
how you read that:

- **Query A (level distribution)** - run it daily. You want `low` overwhelmingly
  dominant and `medium` in the low single-digit percentages. If `medium` is over
  about 5% of scored checkouts, the weights are too hot for the real customer
  base and enforcement should stay off until they are retuned.
- **Query B (top reasons)** - tells you WHY. If `parcel_shared` or `ip_cluster`
  tops that list, the score is finding households and carrier NAT, not farmers.
- **Query C (the high list)** - short enough to read by hand. Every row is
  somebody who would not have got a free trial they asked for.

Once that looks sane, set `RISK_ENFORCE=true` in Vercel and redeploy.

### What it does when enforcement is on

Nothing refuses a sale. `medium` and `high` both mean only "no free trial,
billed from day one", and the auto-renewal disclosure the buyer consents to
states the immediate charge, so nothing they were shown is untrue. `high` is
additionally logged to the Vercel logs with the user id and the reasons.

The one thing that DOES refuse a sale is a hand-written `manual` row in
`abuse_flags`, which only a human can create.

### The admin surface is a SQL snippet, not a page

There is no admin UI on purpose. To give somebody their trial back (or take it
away), insert a `risk_overrides` row - statement D in the PASTE-ME file.
`trialDecision()` checks that table before it computes anything, so an override
is absolute in both directions. Always fill in the `note`.

Until step 2 is run, the whole system is inert by design: recording a signal is
a no-op and `trialDecision()` returns allow/allow, exactly the behaviour that
shipped before it existed.

## 8. Security audit follow-ups

The 2026-07-19 red-team blockers were remediated in the waves committed on this branch
(re-verified 2026-08-09 by a fresh security sweep: webhook signatures, cron auth, RLS on new
tables, and ownership checks on ~20 API routes all pass). Remaining operational items:

1. Live DB must be at migration 0113 (it was as of 2026-07-22; probe before launch).
2. After setting the env vars above, re-check the abuse limits still hold in production
   (email fan-out caps, rate limits) by skimming the first week of cron logs.

## 9. The outbound kill switch and the per-process cap

Two brakes sit in front of every outgoing email and SMS, at the one door all of
them go through (`sendOutboundChannels` in `src/lib/notify.ts`). Neither touches
the in-app notification row, which is written before either runs, so nothing a
recipient needs to know is ever lost - only the push is held back.

### `OUTBOUND_DISABLED` - the lever to pull at 3am

Set `OUTBOUND_DISABLED=1` (or `true`) in Vercel and redeploy the env var. From
that moment no email and no SMS leaves the process: each call logs one line and
returns.

Pull it when:

- a cron is looping and texting the same people repeatedly,
- a job-post fan-out is firing at the wrong audience,
- a preview or staging deploy turns out to be pointed at the live Resend or
  Twilio credentials.

It is read on every send, not cached at cold start, so it takes effect on the
next message rather than the next deploy cycle. Unset it (or set it to anything
else) to resume. There is no queue behind it: messages suppressed while it is on
are not sent later.

### The per-process cap - the brake that works while nobody is watching

`OUTBOUND_PER_MINUTE` in `src/lib/outboundGuards.ts` caps outbound
notifications at 600 per minute per server process. Beyond that they are
dropped, and the log carries the greppable prefix:

```
[ALERT] outbound per-process cap tripped (600/minute) - dropping sends
[ALERT] outbound cap dropped N sends in the last minute (cap 600)
```

600 is far above anything real - the largest single fan-out is a job post to
about 200 pros, and those arrive minutes apart - and a runaway loop reaches it in
seconds. It is deliberately per PROCESS, so it costs no database round trip in
the hot path; a serverless deployment runs several in parallel, which makes this
a blast-radius limiter rather than an exact quota. The database-backed limits
upstream (`post:`, `post-day:` in `src/app/(app)/contractors/actions.ts`) are
what bound the true total.

If a real launch-day fan-out ever trips it, raise the constant deliberately in
one commit rather than letting it throttle silently.

### Log prefixes worth a saved Vercel search

`[ALERT]` marks the owner-wide ceilings tripping - the ones that mean Hearth is
refusing its own customers rather than an individual abusing their allowance:

- `[ALERT] AI global spend breaker tripped ...` (`src/lib/aiUsage.ts`)
- `[ALERT] AI global hourly ceiling tripped ...` (`src/lib/aiUsage.ts`)
- `[ALERT] address-suggest global ceiling tripped ...`
- `[ALERT] outbound ...` (above)

Nothing pages a human on these yet. Saving the search is the interim answer.

## 10. Phone notifications (Web Push)

This is what makes a phone buzz when Hearth is CLOSED. It costs nothing per message: the
browser's own push service (Apple, Google, Mozilla) does the delivery, so it is free for
homeowners and pros alike and is not a Hearth Plus perk. Code is in `src/lib/push.ts`,
`public/sw.js` and `src/app/api/push/subscribe`, dormant until the keys exist.

1. Run the database bundle `supabase/PASTE-ME-live-2026-08-29-push.sql` (migration 0143,
   one new table `public.push_subscriptions`). Without it the "Turn on notifications"
   button reports that the server is not set up yet.
2. Generate a key pair once, from the repo:
   `npx web-push generate-vapid-keys`
3. In Vercel, set all three (Production and Preview):
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY` - the public half. Public by design: the browser needs
     it to subscribe, so it ships in the client bundle.
   - `VAPID_PRIVATE_KEY` - the secret half. Server only. Never prefix it with `NEXT_PUBLIC_`.
   - `VAPID_SUBJECT` - a contact address for the push services, as `mailto:you@example.com`.
   Missing any one of them and push stays dormant with a single `sendPush:` warning in the
   logs. Nothing else breaks.
4. Verify on an iPhone. THIS IS THE STEP PEOPLE GET WRONG: iOS delivers Web Push only to a
   site that has been added to the Home Screen (iOS 16.4+). In a Safari tab there is no
   permission to grant, and the app says so instead of showing a dead button. So: open
   Hearth in Safari, Share -> Add to Home Screen, open it from the new icon, then
   Account -> Notifications -> Turn on notifications and allow the prompt. On the pro side
   the same control is on My Business. Android Chrome works from a plain tab.
5. Then have a second account send a message and confirm the notification arrives with the
   app fully closed (swiped away, not just backgrounded).

Rotating the keys invalidates every stored subscription. The app self-heals: anyone who
already granted permission is re-subscribed on their next visit
(`src/components/PushRegistrar.tsx`), and dead rows are deleted the first time a send comes
back 404/410.

`OUTBOUND_DISABLED` (section 9) stops push as well as email and SMS. That is deliberate: the
lever exists for the moment a cron is looping, and a looping cron buzzing every phone we have
is exactly the blast radius it is there to contain.

## Not covered here

Legal blockers (DMCA agent registration, TODO(legal) placeholders) are tracked separately
and are being handled with a lawyer. They remain launch-blocking.
