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

## 7. Security audit follow-ups

The 2026-07-19 red-team blockers were remediated in the waves committed on this branch
(re-verified 2026-08-09 by a fresh security sweep: webhook signatures, cron auth, RLS on new
tables, and ownership checks on ~20 API routes all pass). Remaining operational items:

1. Live DB must be at migration 0113 (it was as of 2026-07-22; probe before launch).
2. After setting the env vars above, re-check the abuse limits still hold in production
   (email fan-out caps, rate limits) by skimming the first week of cron logs.

## Not covered here

Legal blockers (DMCA agent registration, TODO(legal) placeholders) are tracked separately
and are being handled with a lawyer. They remain launch-blocking.
