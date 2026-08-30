# Analytics

Hearth's analytics is first-party only: no PostHog, Plausible, Vercel
Analytics, or any other third-party vendor. Every event is a row in
`public.app_events` (migration 0091), written either by the client sink at
`src/app/api/track/route.ts` (fed by `track()` in `src/lib/analytics.ts`) or
directly by server code through `trackServerEvent()` in
`src/lib/trackServer.ts`. This choice is not a preference, it is a
requirement: `src/app/privacy/page.tsx` already promises "no third-party
analytics service, no advertising SDK, no ad pixel or retargeting tag" in
writing, and adding one would make that page false the moment it shipped.

`app_events` has row level security enabled with zero policies. No
anon/authenticated client can read or write it, on purpose - only the
service-role admin client (used by the track route and by
`trackServerEvent`) can touch it. Nothing in the app reads it back today; it
exists to be queried directly against the database.

## Adding a new event

- Server-side (an action, a route handler, a webhook): call
  `trackServerEvent(userId, event, props)` from `src/lib/trackServer.ts`.
  `userId` may be `null` for a signed-out visitor.
- Client-side (a component, fired from the browser): call
  `track(event, props)` from `src/lib/analytics.ts`, AND add the event name
  to `CLIENT_ALLOWED_EVENTS` in `src/app/api/track/route.ts`. An event name
  not on that allowlist is silently dropped by the route - a visitor cannot
  forge an event that isn't listed there.
- Never add a server-only event (one only `trackServerEvent` should ever
  write, like a money-moving or moderation event) to `CLIENT_ALLOWED_EVENTS`
  - that route is public and unauthenticated, so anyone could POST a fake one.

## Payload rule

Every `props` payload is ids and enums only. Never free text, never an
email, phone number, or address, and never a homeowner's actual question to
Ask Hearth. A number (a count, a plan name, a reason code) is fine; a string
someone typed into a form is not. `props` is capped at 1024 serialized
characters by the client route and is logged with a redactor
(`src/lib/logSafe.ts`) if the table is ever missing, but the payload rule
exists so nothing sensitive is ever written in the first place, not because
the redactor is expected to catch it.

## Event list

### Homeowner side

| Event | Fires | Side |
|---|---|---|
| `signup_homeowner` | `src/app/homeowner-signup/page.tsx`, once per signup (the two call sites are mutually exclusive branches - confirmation off vs on - never both) | Client |
| `home_claimed` | `src/app/onboarding/actions.ts`, right after a property insert succeeds. `props: { match_source: "real" \| "manual" }` - "real" means the county assessor had a record for the exact street claimed, "manual" means no matching record, regardless of whether the later ownership-name check passed | Server |
| `plan_built` | `src/app/(app)/dashboard/actions.ts`, `generateMaintenancePlanAction`, only when the build actually schedules new tasks (a no-op re-run fires nothing). `props: { task_count }` | Server |
| `post_job` | `src/app/(app)/contractors/actions.ts` - pre-existing, kept as-is rather than renamed to `job_posted` (renaming would lose historical continuity for no benefit) | Server |
| `choose_applicant` | `src/app/(app)/contractors/actions.ts` - pre-existing; this is the "pro hired" moment, no separate event needed | Server |
| `ask_asked` | `src/app/api/ask/route.ts`, once a question has cleared every gate (home claimed, not over any limit) and is about to be answered. `props: { tier }`. Never the question text | Server |
| `paywall_seen` | `src/app/(app)/plus/page.tsx`, once per render of any `?reason=` upsell banner. `props: { reason }` (one of the values the banners on that page actually check: `job_limit`, `home_limit`, `plan`, `forecast`, `quote`, `ask`, `report`, `tax`, `value`, `insurance`, `documents`, `inspection`) | Server |
| `checkout_started` | `src/app/(app)/plus/actions.ts`, `startPlusCheckoutAction`, right before redirecting to the Stripe session. `props: { plan }` | Server |
| `checkout_completed` | `src/app/api/stripe/webhook/route.ts`, on `checkout.session.completed` for `metadata.type === "plus_subscription"` - the trustworthy completion signal, not the `?welcome=1` page render, which can beat or lose the race with this webhook. `props: { plan }` | Server (webhook) |
| `checkout_abandoned` | `src/app/api/stripe/webhook/route.ts`, on `checkout.session.expired` for `metadata.type === "plus_subscription"`. `props: { plan }` | Server (webhook) |
| `push_enabled` | `src/components/PushSettingsCard.tsx`, when `Notification.requestPermission()` (via `enablePush`) resolves `"granted"`. Shared by both sides of the app; `props: { side: "homeowner" \| "pro" }` tells them apart | Client |
| `feedback_sent` | `src/app/(app)/feedback/actions.ts`, `submitFeedbackAction`, after a successful insert. `props: { side: "homeowner" }`, never the message text | Server |
| `contact_sent` | `src/app/contact/actions.ts`, `sendContactMessageAction`, after a successful insert (not on the honeypot's fake-success path). `user_id` is always `null`: the account match this route computes is an unverified triage hint, not a confirmed identity, so it is never used to attribute an analytics event | Server |

### Pro side

`src/app/pro/actions.ts` no longer carries its own copy-pasted
`trackServerEvent`; it imports the shared one from `src/lib/trackServer.ts`,
same as `src/app/(app)/contractors/actions.ts`.

| Event | Fires | Side |
|---|---|---|
| `signup_pro` | `src/app/pro/actions.ts`, `saveCompanyAction`, right after the contractors row insert succeeds on first-time setup - before the license/CSLB/terms/side-stamp work that follows it, so a signup is counted even if one of those later steps fails | Server |
| `onboarding_done` | `src/app/pro/actions.ts`, `saveCompanyAction`, at the very end of the first-time-setup branch, once the whole wizard has actually finished (terms accepted, CSLB check attempted, preferred side stamped). Distinct from `signup_pro`: one is "the row exists", the other is "the pro is fully set up" | Server |
| `license_verified` | `src/app/pro/actions.ts`, `verifyContractorLicense`, only on the write that actually lands `license_verified_status = 'verified'` - never on a failed or unknown CSLB outcome, and never on the 23505 duplicate-license race (that path downgrades to `failed` before reaching this point). Shared by all three callers: onboarding, a profile save that changes the license number, and the "Verify now" button | Server |
| `deposit_made` | `src/app/api/stripe/webhook/route.ts`, `creditDepositSession`, only on the `apply_deposit` RPC call that actually credited the wallet (never a refused out-of-band amount, an unsettled ACH session, or a failed/retryable RPC). `props: { amount_bucket }` - the deposit rounded UP to the nearest $250, never the exact cents Stripe charged | Server (webhook) |
| `lead_viewed` | `src/app/pro/leads/page.tsx`, once per render of the board, after the closed-job sweep so the count matches what the pro actually sees. `props: { count }` - the number of open jobs shown, never a job id or any lead detail | Server |
| `lead_applied` | Already exists as `pro_apply` (see below); no separate event | - |
| `message_replied` | `src/components/LeadChat.tsx`, the pro side of `send()`, right after a text message the pro sent lands. Client-side (this send path has no server action to hang a `trackServerEvent` call off), so it goes through `track()` and is on `CLIENT_ALLOWED_EVENTS`. `props: { side: "pro" }` - homeowner replies are a separate pass, not covered here | Client |
| `pro_checkout_started` | `src/app/pro/plus/actions.ts`, `startProCheckoutAction`, right before redirecting to the Stripe session. `props: { plan }` | Server |
| `pro_checkout_completed` | `src/app/api/stripe/webhook/route.ts`, on `checkout.session.completed` for `metadata.type === "pro_subscription"` - the trustworthy completion signal, mirroring `checkout_completed` on the homeowner side. `props: { plan }` | Server (webhook) |
| `pro_checkout_abandoned` | `src/app/api/stripe/webhook/route.ts`, on `checkout.session.expired` for `metadata.type === "pro_subscription"`, mirroring `checkout_abandoned`. `props: { plan }` | Server (webhook) |
| `feedback_credit_claimed` | `src/lib/proFeedbackServer.ts`, `grantFeedbackCredit`, only when this call is the one that actually moved the $5 (never a retry that found the claim already spent) | Server |
| `free_draft_used` | `src/app/api/pro-tools/route.ts`, right after `claimProDraft` reports `claimed: true` - fires whether or not the model goes on to produce a document, since the taste is spent (and refundable) the moment the claim lands, not at delivery. `props: { tool }` (`estimate`, `invoice`, `followup`, `review_response`, or `overdue`) | Server |

### Already live, unaffected by this pass

`post_job_from_chat`, `hero_demo_play` (client, `CLIENT_ALLOWED_EVENTS`);
`job_won`, `pro_apply`, `direct_request` (server, pro/homeowner-crossing
events already wired).

## Querying the funnel

Run these directly against the database (service-role / SQL editor only -
`app_events` has no policy granting any client role a read).

**1. Signup -> home claimed -> plan built, last 30 days**

```sql
select
  count(*) filter (where event = 'signup_homeowner') as signed_up,
  count(*) filter (where event = 'home_claimed')      as claimed_home,
  count(*) filter (where event = 'plan_built')         as built_plan
from public.app_events
where created_at >= now() - interval '30 days'
  and event in ('signup_homeowner', 'home_claimed', 'plan_built');
```

**2. Paywall seen -> checkout started -> checkout completed, by reason**

```sql
select
  props ->> 'reason' as reason,
  count(*) filter (where event = 'paywall_seen')       as saw_paywall,
  count(*) filter (where event = 'checkout_started')    as started_checkout,
  count(*) filter (where event = 'checkout_completed')  as completed_checkout
from public.app_events
where created_at >= now() - interval '30 days'
  and event in ('paywall_seen', 'checkout_started', 'checkout_completed')
group by props ->> 'reason'
order by saw_paywall desc nulls last;
```

(`checkout_started`/`checkout_completed` carry `plan`, not `reason`, so their
counts land in the `null` reason row - useful as an overall total, not a
per-reason breakdown for those two columns.)

**3. Ask Hearth usage per day**

```sql
select
  date_trunc('day', created_at) as day,
  props ->> 'tier' as tier,
  count(*) as questions_asked
from public.app_events
where event = 'ask_asked'
  and created_at >= now() - interval '30 days'
group by 1, 2
order by 1 desc, 2;
```

**4. Pro signup -> onboarding done -> license verified, last 30 days**

```sql
select
  count(*) filter (where event = 'signup_pro')        as signed_up,
  count(*) filter (where event = 'onboarding_done')    as finished_onboarding,
  count(*) filter (where event = 'license_verified')   as verified_license
from public.app_events
where created_at >= now() - interval '30 days'
  and event in ('signup_pro', 'onboarding_done', 'license_verified');
```

**5. Pro checkout: started -> completed -> abandoned, by plan**

```sql
select
  props ->> 'plan' as plan,
  count(*) filter (where event = 'pro_checkout_started')    as started,
  count(*) filter (where event = 'pro_checkout_completed')  as completed,
  count(*) filter (where event = 'pro_checkout_abandoned')  as abandoned
from public.app_events
where created_at >= now() - interval '30 days'
  and event in (
    'pro_checkout_started', 'pro_checkout_completed', 'pro_checkout_abandoned'
  )
group by props ->> 'plan'
order by started desc nulls last;
```

## Privacy

Hearth does not sell or share personal data with any third party, and
nothing in this pipeline changes that. `app_events` rows live in Hearth's own
database, are linked to an account only when one is signed in, and are never
sold, licensed, or shared with any third-party ad or analytics company - the
same commitment already stated in `src/app/privacy/page.tsx`. Under
CCPA/CPRA, "sale" and "share" are defined broadly enough to cover far more
than a literal cash transaction, and Hearth's core data (home address,
financial details) counts as sensitive personal information, so this is a
hard line, not a preference that could shift later. What remains legitimately
available from this data is aggregate, de-identified statistics with no path
back to an individual record - for example, "the median Orange County home
spends $X/year on maintenance" - published or licensed as a statistic, never
as rows tied to a person.
