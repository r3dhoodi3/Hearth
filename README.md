# Hearth

A homeowner maintenance tool with a home-services marketplace attached. The
owner's job-to-be-done is the product: keep my house in good shape, tell me
what needs attention, store my home docs, and get me a trustworthy contractor
when something breaks. Pros pay for leads; homeowners can upgrade to Hearth
Plus for proactive alerts and reports.

Launching in Orange County, CA: Huntington Beach, Fountain Valley, Seal
Beach, Westminster, Midway City, Garden Grove, Santa Ana, Costa Mesa, and
Newport Beach. Homeowner ZIP codes and pro service cities are gated to that
list end to end (see `src/lib/serviceArea.ts`).

For the current state of the project, decisions, and what is next, read
`HANDOFF.md`. Go-live steps live in `docs/`.

## What's built

**Homeowner side** (`src/app/(app)/`)

- Onboarding and address claim with county-record prefill (RentCast)
- Home Health dashboard, systems digital twin, maintenance plan, seasonal
  checklist, weather alerts
- Report an issue, request a pro directly or post a job publicly, in-app chat
- Contractor browse, quote check (AI quote analysis), forecast, home value,
  tax appeal, insurance check-up, inspection ingest, walkthrough
- Documents vault, home report (printable), emergency help, guides
- Household sharing (invite members by link)
- Ask Hearth assistant (Anthropic's Claude)
- Account: security, notifications, privacy rights, help
- Hearth Plus subscription via Stripe (free / annual / monthly)

**Pro side** (`src/app/pro/`)

- Contractor signup and onboarding, CSLB license verification with identity
  lock (one license per account, `src/lib/licenseMatch.ts`)
- Job board filtered to the pro's launch cities, lead purchase with a prepaid
  wallet, first-apply guarantee, refunds
- CRM, past jobs, structured quotes and invoices, reviews, win cards, widget
- Pro Plus, playbook, tools, weekly digest, compliance calendar
- Background checks (Checkr) paid by Hearth after 3 paid leads

**Public** (`src/app/`)

- Landing, city pages, pricing, guides, public pro profiles (`/p/[id]`),
  legal pages (terms, privacy, pro terms, DMCA, AI disclosure)
- Sign in with email/password, Google, or Apple

**Backend**

- `src/app/api/` route handlers for AI, Stripe webhooks, Twilio, Checkr,
  document extraction, and 16 cron jobs under `src/app/api/cron/` (schedules
  in `vercel.json`, protected by `CRON_SECRET`)
- Email via Resend, SMS via Twilio. Proactive email/SMS alerts are Plus-only,
  enforced in `src/lib/notifyGating.ts`; billing notices are never gated.

## Stack

- **Next.js 15** + **React 19** (App Router, TypeScript, Server Actions),
  **Tailwind CSS**, `lucide-react` icons. `cookies()`, `headers()`, and a
  page's `params`/`searchParams` are async: server code awaits them, and
  `createClient()` from `src/lib/supabase/server.ts` is async for the same
  reason, so every call site awaits it.
- **Supabase**: Postgres, Auth (email + password with confirmation, Google,
  Apple), Storage (private photo and document buckets)
- **Stripe** subscriptions and wallet top-ups, **Resend**, **Twilio**,
  **Checkr**, **RentCast**, **Anthropic** (Claude, the only AI provider)
- **Vitest** + Testing Library for unit tests
- Deployed on **Vercel**

Row Level Security is on for every table. A homeowner can only reach their own
homes (and homes shared with them); pros only reach leads they hold. Money and
trust columns are locked with column-level grants, and RPCs that touch money
claim state atomically before any paid call.

## Project layout

```
supabase/migrations/   0001 .. 0126 schema, RLS, RPCs (123 files, gaps are fine)
supabase/PASTE-ME-*    combined files that were pasted into the live SQL editor
supabase/MIGRATIONS.md how migrations are tracked and how to baseline the CLI
src/lib/               supabase clients, auth helpers, health/forecast/pricing
                       logic, notify gating, service area, license matching
src/lib/*.test.ts      unit tests (co-located)
src/app/               public pages, signup/signin, onboarding, api routes
src/app/(app)/         signed-in homeowner shell
src/app/pro/           signed-in pro shell
src/components/        shared UI (Nav, AskHearth, ChatDock, PhotoUpload, ...)
docs/                  go-live wiring, deploy runbook, launch playbook,
                       Apple sign-in setup, App Store checklist, pricing notes
HANDOFF.md             current state, decisions, next steps, gotchas
```

## Local setup

### 1. Install

```bash
npm install
```

### 2. Environment

```bash
cp .env.local.example .env.local
```

Required to run the app at all:

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the
  `sb_publishable_...` key): auth and every data read.
- `SUPABASE_SERVICE_ROLE_KEY`: used at render time by contractor browse, the
  pro dashboard, parcel lookup, and most server actions. Bypasses RLS, so it is
  only ever read on the server (`src/lib/supabase/admin.ts`). Never share it or
  ship it to the browser.

Optional, each turns on one feature and is skipped when missing:

- `STRIPE_SECRET_KEY` (+ price ids, webhook secret): checkout, billing portal,
  wallet top-ups. Pages load without it; billing actions fail with an error that
  names the variable. A test-mode key works locally.
- `ANTHROPIC_API_KEY`: Ask Hearth, quote analysis, document extraction, and
  every other AI feature. All of them run on Claude.
- `RENTCAST_API_KEY`: county-record prefill in onboarding and home value.
- `RESEND_API_KEY`/`RESEND_FROM`, `TWILIO_*`: email and SMS; senders no-op
  without them.
- `CHECKR_API_KEY`: background checks; the card hides without it.
- `CRON_SECRET`: cron routes reject every call until it is set.

`.env.local.example` documents each one.

### 3. Database

The live project is on Supabase. Schema changes are written as numbered files
in `supabase/migrations/` and applied to the live project by pasting the
matching `supabase/PASTE-ME-*.sql` file into the SQL editor, then verified
read-only afterward. `supabase/MIGRATIONS.md` describes the pending one-time
baseline that lets `npm run db:push` take over.

For a fresh local stack (needs Docker):

```bash
npx supabase start
npx supabase db reset     # applies every migration
```

### 4. Run

```bash
npm run dev          # http://localhost:3000
npm run typecheck    # tsc --noEmit
npm run test         # vitest (196 tests across 14 files as of 2026-08-20)
npm run build
```

If localhost throws webpack "reading 'call'" errors after a large batch of
file changes, stop the server, delete `.next`, and start it again. Changes to
`next.config.mjs` also need a restart.

### 5. Regenerate DB types after schema changes

```bash
npm run db:types     # supabase gen types typescript --local > src/lib/database.types.ts
```

Some newer columns are not in `database.types.ts` yet; read sites cast to
`any` with a comment pointing at the migration that added the column.

## Signups in development

Supabase's built-in mailer only delivers confirmation emails to addresses that
are members of the Supabase project team, and caps at roughly two emails an
hour. Until custom SMTP (Resend) is configured in Supabase Auth settings
(`docs/GO-LIVE-WIRING.md`), a signup from any other address fails with
`email_address_invalid`, which the UI shows as "That didn't go through". To let
a tester in before then, invite their email on the Supabase org's Team tab.

## Windows build note

On Next 14, `npm run build` failed on Windows during static prerender of
`/opengraph-image` (a `file://` URL bug inside the bundled `@vercel/og`).
Next 15 ships a newer bundle and the failure is gone: a full `npm run build`
on Windows now exits 0 with no export errors. `src/lib/ogFont.ts` is kept
because it still covers the dev-server path.

## Data and revenue, honestly

- **Condition signal**: `home_systems` + `issues` are most of the value.
- **Revenue**: pros buy leads (`contractor_leads`) with a prepaid wallet;
  homeowners subscribe to Hearth Plus. No license or RESPA exposure.
- **Sell-intent** lives in a separate `intent_signals` table with a
  `shared_consent` flag. Opt-in warm intros only; see [PRIVACY.md](./PRIVACY.md).

## Working agreements

- Live DB changes ship as `PASTE-ME` files; the owner pastes them; the change
  is verified read-only afterward.
- Anything money- or security-adjacent gets an independent review before push.
- Copy states facts the code enforces. Perk pages are cross-checked against
  the enforcement code.
- UI stays compact and plain: no per-trade pictograms, general icons only.
