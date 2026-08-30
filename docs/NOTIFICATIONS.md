# Notifications

The one entry point is `sendNotification(supabase, input)` in `src/lib/notify.ts`.
It always writes the in-app row (`public.notifications`, what the bell in the nav
shows), then tries push, email, and SMS - all three stay dormant until their
provider env vars exist, so wiring one up later is just adding keys, no code
changes. See `docs/GO-LIVE-WIRING.md` for how to turn each channel on.

Every notification carries a `kind` - a short snake_case string (`"message"`,
`"quote_sent"`, `"seasonal_check"`...). Three separate rules key off `kind`, each
in its own allowlist in `src/lib/notifyGating.ts`, and each independent of the
other two:

| Gate | List | Default for an unclassified kind | Enforced in |
| --- | --- | --- | --- |
| Hearth Plus paywall (email/SMS only) | `PLUS_GATED_NOTIFICATION_KINDS` | ships free | `sendNotification` (`src/lib/notify.ts`) |
| Push allowlist (buzzes a phone at all) | `PUSH_NOTIFICATION_KINDS` | stays silent | `sendPush` (`src/lib/push.ts`) |
| Marketing frequency cap | `TRANSACTIONAL_NOTIFICATION_KINDS` | counted against the budget | `sendNotification` (`src/lib/notify.ts`) |

The in-app row is written for every kind, every time, regardless of any of
these three gates. What the gates decide is whether the OTHER channels fire.

## The marketing / campaign frequency cap

At most `MARKETING_BUDGET_MAX_PER_WINDOW` (2) non-transactional notifications
reach one person per rolling `MARKETING_BUDGET_WINDOW_DAYS` (7), counted across
every campaign kind together - a seasonal nudge and a review ask draw from the
same budget rather than each getting its own. This is a guardrail against
notification fatigue, not a growth lever: it exists so three independently
well-behaved campaigns cannot add up to a phone that gets buzzed six times a
week.

`TRANSACTIONAL_NOTIFICATION_KINDS` (`src/lib/notifyGating.ts`) is the only list
the cap consults, and it is an allowlist of **exemptions** - the opposite
default from the Plus gate above it. A kind nobody has classified yet counts
against the budget. That is deliberate: a forgotten campaign that ships
unmetered is exactly the bug this cap exists to prevent, so the safe default
here is "metered," not "free."

Exempt (transactional) today:
- Someone is waiting on this: `message`, `direct_request`, `direct_accepted`,
  `direct_declined`, `quote`, `quote_sent`, `invoice`, `invoice_sent`,
  `invoice_signed`, `job_closed`, `new_lead`, `new_review`,
  `applicant_waiting`, `quote_analysis`.
- Money moved, or a card just failed to move it, or the law requires the
  disclosure: `apply_receipt`, `apply_credit_back`, `ghost_refund`,
  `first_apply_guarantee`, `referral_reward`, `payment_failed`,
  `payment_failed_followup`, `renewal_reminder`, `annual_notice`,
  `renewal_acknowledgment`.
- Account security / compliance status - required action items, not asks:
  `background_check_clear`, `compliance`, `license`, `insurance`,
  `trial_abuse`.
- Safety alerts, time-critical by definition: `freeze`, `heat`, `high_wind`,
  `heavy_rain`, `recall`.
- An internal digest to the app owner, not a customer-facing message:
  `support_digest`.

Everything else - `maintenance_upcoming`, `maintenance_overdue`,
`filter_reminder`, `seasonal_check`, `insurance_renewal`, `home_digest`,
`weekly_digest`, `aging_deal`, `winback_credit`, `review_request`, and any new
kind you add - is metered.

The check runs first, inside `sendNotification`, before the in-app row is even
written: a person already at budget for the week gets neither the bell row nor
the outbound channels for a non-transactional kind. `withinMarketingBudget`
(`src/lib/notify.ts`) does the count; `marketingBudgetAllows`
(`src/lib/notifyGating.ts`) is the pure window-math predicate it wraps, so the
math itself is unit-testable without a database.

**Fails CLOSED.** If the count read errors, a marketing-class send is refused,
not allowed through. That is the opposite direction from the email opt-out
check elsewhere in `src/lib/notify.ts`, which fails open on the theory that the
safest thing to do when unsure is still to deliver a message with an
unsubscribe link in it. The marketing cap exists to prevent exactly the failure
mode a fail-open default would create here: an outage that lets a runaway
campaign send unmetered for as long as it lasts. A transactional kind is
checked first and returns `true` immediately, with no database read at all, so
this failure mode can only ever touch a kind that was already metered.

## Dunning delivery

`invoice.payment_failed` (Stripe webhook, `src/app/api/stripe/webhook/route.ts`)
flags the subscription `past_due` and writes one in-app + email + push notice
per failed invoice the moment the card declines (kind `payment_failed`, now on
`PUSH_NOTIFICATION_KINDS` - a card that just failed during a live retry window
is worth a buzz, unlike the pre-charge renewal/annual notices, which stay
silent). It is deduped on the Stripe invoice id baked into the notice's `url`,
so Smart Retries re-delivering the same webhook event never sends a second
copy for one failed invoice.

`src/app/api/cron/dunning-followup/route.ts` (daily) is the second and last
beat of the same story: for any subscription still reading `past_due`, it reads
back the webhook's own first notice (same `notifications` row, matched by user,
kind, and the plan's cancel path), and once 72 hours have passed with no
resolution, sends one follow-up (kind `payment_failed_followup`) reusing the
same invoice id as its dedupe key. No new table: the notification the webhook
already wrote is the entire memory this cron needs. After that one follow-up it
leaves the invoice alone for good - a resolved subscription flips back to
`active` on the next successful retry and drops out of the cron's query
entirely.

Neither kind is Plus-gated (a billing notice is never a perk to withhold) and
both are exempt from the marketing cap (see the list above) - a card decline is
never mistaken for a campaign.

**Wiring note:** the new cron route is not yet registered in `vercel.json` -
that file belongs to the wave lead, not to this notifications work. Add:

```json
{
  "path": "/api/cron/dunning-followup",
  "schedule": "0 16 * * *"
}
```

to the `crons` array (any daily hour not already taken works; `16:00 UTC` is
free today) or it will never run on a schedule, even though the route itself
is live and callable manually with the cron secret.

## Adding a campaign

1. Pick a `kind` string, snake_case, that does not already exist (grep
   `sendNotification(` for `kind:` across the app to check).
2. Send it through `sendNotification`, same as every other kind - do not write
   directly to the `notifications` table. The marketing cap, the Plus gate, and
   the opt-out rules only apply if you come through that door.
3. Decide, deliberately, whether the kind belongs on `PUSH_NOTIFICATION_KINDS`
   (push allowlist) or `TRANSACTIONAL_NOTIFICATION_KINDS` (marketing-cap
   exemption) in `src/lib/notifyGating.ts`. If you do nothing, the new kind is
   silent on push and metered by the marketing cap - the safe default for
   anything that is, in fact, a campaign.
4. If the campaign is a proactive homeowner alert or reminder (something
   Hearth generates on its own schedule, not requested), also decide whether
   its email/SMS channels are a Hearth Plus perk - `PLUS_GATED_NOTIFICATION_KINDS`
   in the same file.
5. Add a unit test in `src/lib/notifyGating.test.ts` asserting where the new
   kind landed on each list it touches, the same way every existing kind is
   asserted there. A kind with no test is a kind whose classification nobody
   checked.
