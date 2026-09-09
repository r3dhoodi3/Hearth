# William: security and infra list

Owner: William (security/infra go-live work, per Landen 2026-08-21). Landen keeps
the owner-only account and money items. Items are ordered by impact. Each one is
a dashboard setting or a paste, not code; the code-level protections are already
in the repo.

## Build request from Landen (2026-09-01, spec expanded 2026-09-05): permit-based system verification

WHY. When a homeowner claims a home, onboarding seeds the systems with install
years guessed by arithmetic (build year plus the typical lifespans in
`DEFAULT_LIFESPANS`, src/lib/health.ts: roof 22, hvac 18, water_heater 11,
electrical_panel 35, plumbing 50, windows 25, and so on; see
claimPropertyAction in src/app/onboarding/actions.ts). City building permits
are the free public record that turns those guesses into facts: a reroof, an
HVAC changeout, a water heater swap, a repipe, a panel upgrade, a window
retrofit almost always has a dated permit. "The city has a reroof permit from
2016" is a fact no competitor shows, and it is what makes the health score
believable. This is the one substantial engineering build on the board and it
is William's to own end to end.

SCOPE. All of Orange County (the product serves the whole county since
migration 0129; FV/HB is only the marketing order). 34 cities plus the
unincorporated county. Free, no data vendors (no Shovels at about $599/mo, no
ATTOM), no city we have no users in.

THE KEY IDEA: PLATFORM ADAPTERS, NOT CITY SCRAPERS. Cities do not build their
own permit websites; they buy one of a handful of vendor portals and put a
logo on it. One adapter per vendor covers every city on that vendor, and each
new city is a few lines of config. The vendors expected to cover most of the
county (the survey in step 1 confirms which city runs which; treat these as
likely, not verified):

| Adapter | Vendor portal | Notes |
| --- | --- | --- |
| accela | Accela Citizen Access (ACA) | The most common one in SoCal (Huntington Beach and Anaheim look like ACA). Search by address, results table, permit detail page. |
| etrakit | eTRAKiT (CentralSquare) | Common in mid-size cities. Address search, permit list, detail page. |
| tyler | Tyler EnerGov / Tyler CSS | Newer installs and recent upgrades. JSON-backed search endpoints behind the UI. |
| opengov | OpenGov / ViewPoint Cloud | Smaller cities that moved online recently. Public records search. |
| county | County of Orange portal | Unincorporated areas only. |
| csv | Open-data export | Some cities publish permits as a downloadable CSV or an open-data API. Always check for this first; a free export beats a scraper. |

Four to six adapters should cover most of the county. A city on a vendor we
have not built simply keeps its arithmetic estimates; honest gaps are fine.

Per-city config (one small object per city, no code):
`{ city: "Huntington Beach", adapter: "accela", baseUrl: "...", agencyCode: "...", quirks: {...}, enabled: true }`.

BUILD PLAN, in order. Each step is shippable on its own.

1. Survey (an afternoon). Open every OC city's permit lookup page, record the
   vendor, the base URL, whether an address search exists without a login,
   whether an open-data export exists, and any captcha or WAF. Output: a
   table checked into docs/permits/SURVEY.md and the per-city config file.
   Roll out in the order users actually appear: FV and HB first, then wherever
   claimed homes exist.
2. Adapter interface plus the first adapter. One TypeScript interface:
   `searchPermits(address, config) -> Permit[]` where a Permit is
   `{ permitNumber, issuedDate, finaledDate?, type, description, contractor?, sourceUrl }`.
   Same engineering pattern as the CSLB license scraper (src/lib/cslb.ts):
   polite rate limits, WAF-aware fetch with a real user agent, parse
   defensively, fail soft (an adapter error never blocks anything else),
   fixtures from saved HTML so tests run offline. Start with whichever vendor
   covers FV or HB.
3. Classifier. Map permit text to the system types the app tracks. Keyword
   table, case-insensitive, first match wins, with a confidence:
   reroof / re-roof / roofing -> roof; HVAC / furnace / air conditioner /
   condenser / mechanical changeout -> hvac; water heater / WH replacement ->
   water_heater; repipe / re-pipe / plumbing -> plumbing; panel / service
   upgrade / 200A / electrical service -> electrical_panel; window retrofit /
   window replacement -> windows. Anything else is ignored. Unit tests on
   real permit descriptions from the survey.
4. Data model (one migration, pasted live by Landen as a PASTE-ME file, never
   the CLI). On home_systems add `source` (enum: estimated, permit,
   owner_confirmed; existing rows are estimated unless confirmed_at is set),
   `source_ref` (permit number), `source_url`, `source_date`. New table
   `property_permits` (property_id, permit_number, issued_date, type,
   description, contractor_name, source_url, fetched_at, unique on
   property_id + permit_number) so every permit we ever read is kept and the
   lookup can be re-run without re-scraping. RLS: owner read only, no client
   writes; the cron uses the service role.
5. Nightly cron (Vercel cron, secret-gated like the others in vercel.json).
   For each claimed property in an enabled city: skip if fetched within 7
   days; run the adapter; store permits; classify; for each system whose
   confirmed_at is null, if a permit gives a later install year than the
   estimate, set install_year, source = permit, source_ref, source_url,
   source_date. Batch by city, one request every few seconds, stop the city
   on repeated errors, log counts. Look up each address at most weekly.
6. UI. In SystemRow show a small "from city permit records" note with the
   permit date and a link to the source when source = permit. Keep
   confirmed_at reserved for the owner's own confirmation; a permit never
   sets it. Health score treats a permit year like an estimate that happens
   to be accurate (no scoring change needed).
7. Trust moment. One notification per property when the first permit lands:
   "We found the 2016 reroof permit for your home and updated your roof's age."
   Reuse the notifications table and the existing bell.

RULES, non-negotiable:
- Only rows the owner has NOT confirmed (confirmed_at null) may be updated.
  Owner-entered data is never overwritten.
- Never present a permit-derived year as owner-verified.
- Cache everything; look up each address at most weekly; never hammer a city
  portal; respect robots and rate limits; stop on a captcha.
- No paid vendors at this stage; no city we have no users in.

DEFINITION OF DONE for v1: FV and HB (or the first two cities with users)
live with real permits attached to real claimed homes, the classifier tests
green, the cron running nightly without errors for a week, the note visible
in SystemRow, and the survey doc showing the vendor for all 34 cities.

BONUS, later, do not block v1: permits name the contractor who did the work
(a warm pro-recruiting list for Landen), and fresh permits identify
homeowners mid-project (marketing).

## Status update 2026-09-01 (read this first)

Where things stand as of tonight, so the list below reads against reality:

- **Live DB is fully current through migration 0153** (verified in the SQL
  editor: big-job insurance gate live in both charge functions, repeat bug
  reports unblocked). No SQL pastes are owed right now.
- **A production redeploy on 09-01 activated env vars that had been sitting
  unapplied**: `ANTHROPIC_API_KEY` (re-entered as a shared variable), the
  three VAPID push keys, `RISK_HASH_SALT`, `RISK_ENFORCE`. Env edits in
  Vercel do nothing until a redeploy; that is what had Ask OakTend down.
- **Stripe is in TEST mode in production ON PURPOSE** (Landen, 09-01: still
  testing, switches to the live key at go-live). The env-separation alert in
  the logs fires on every request until then; that is expected. At go-live:
  live key in, then `REQUIRE_LIVE_STRIPE=1` so a test key becomes a hard
  error instead of an alert. Do not "fix" the test key before Landen says.
- **Incident, resolved: an Apple sign-up got no `public.users` row**, which
  broke claiming a home and the terms record for that account (FK errors).
  Hotfix `supabase/PASTE-ME-fix-missing-user-row-2026-09-01.sql` backfilled
  the row and re-asserted `handle_new_user()` as security definer; Landen ran
  it live at 21:07. Root cause is not fully proven, so: **after any fresh
  Apple sign-up, check the account can claim a home**. If it recurs, the next
  step is an ensure-row fallback in `/auth/callback` (code change, small).
- **Shipped be74eda: stale-deploy auto-recovery.** Pages left open across a
  deploy used to fail every form submit with "Failed to find Server Action"
  until someone thought to refresh. Such pages now reload themselves once
  (`src/lib/staleDeploy.ts`; wired into the root layout, all three error
  boundaries, and the onboarding form). Pages loaded before be74eda still
  need one manual refresh; everything after heals itself.
- Corrections to stale notes floating around: the app is already on
  **Next 15.5 / React 19** (no upgrade pending), and the launch area is
  already **all of Orange County** (migration 0129), not just FV/HB.

Still open from the list below, in current priority order: service-role key
rotation (6), Resend SMTP (2), signup captcha (3), RLS audit (1), per-IP rate
limits (4), confirm-email back ON in Supabase Auth, deleting the throwaway
test accounts, `TWILIO_*` in Vercel (14), delete `GEMINI_API_KEY` (7).
Apple key rotation from item 11 is DONE (08-30: old key revoked, new key
86W6M42H37; the client-secret JWT now expires 2027-02-27, calendar reminder
mid-February 2027).

## Working in this repo with Claude Code

House rules Landen holds every session to; they apply to yours too:

1. **Never commit or push without Landen's explicit go-ahead, per push.** A
   yes yesterday does not carry to today.
2. **Gate before calling anything done**: `npx tsc --noEmit`, `npx vitest
   run`, and a production build with `$env:NEXT_DIST_DIR=".next-build"; npm
   run build` (never build into `.next` while a dev server runs). Check real
   exit codes, not scrollback.
3. **Live schema changes are SQL-editor pastes, never the CLI**, and every
   pending migration ships as one combined `PASTE-ME-*.sql` with a precheck
   guard. Editing repo SQL alone changes nothing on live.
4. **Money logic and RLS are review-first**: anything touching wallets,
   charges, grants, or policies gets read end-to-end before it lands.
5. Mobile formatting changes stay behind breakpoints (desktop stays
   byte-identical), and every homeowner-side phone change gets mirrored on
   the pro side in the same wave.

## Before launch

1. **RLS audit, live DB.** Run queries 1a and 1b from
   `supabase/PASTE-ME-live-audit-rls.sql` in the Supabase SQL editor and confirm
   both return zero rows. On 08-20 the live `properties` table had drifted to
   wide open from a dashboard click; other tables were spot-checked, not audited.
   Never use the dashboard policy templates; every policy lives in
   `supabase/migrations`.
2. **Email: Resend SMTP in Supabase.** Supabase Auth's built-in mailer only
   delivers to project team members (about 2 an hour). Authentication ->
   SMTP settings -> Resend host, port 465, user `resend`, password = Resend API
   key, sender on the verified domain. Until this is on, nobody outside the
   team can sign up with email.
3. **Signup captcha.** Supabase -> Authentication -> Attack Protection ->
   enable captcha, provider Cloudflare Turnstile. Needs a free Turnstile site
   key + secret from dash.cloudflare.com (Turnstile -> Add site, domain =
   the OakTend domain). The secret goes in Supabase; the site key goes in
   Vercel as `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (the signup forms read it; if
   the forms do not yet render the widget, tell Landen and it is a small code
   change).
4. **Per-IP rate limit on the AI routes.** Vercel -> project `hearth` ->
   Firewall -> Rules -> add: path starts with `/api/ask` OR `/api/pro-ask`,
   rate limit 30 requests per minute per IP, action: deny. Second rule:
   `/api/` overall, 120 per minute per IP. Code already limits per account
   (3/day free, 15/day Plus, 6/minute, global 1,500/hour) and refuses chat
   for accounts with no claimed home; this rule stops one machine spraying
   many accounts.
5. **AI vendor spend cap.** Landen sets it: console.anthropic.com -> Settings
   -> Limits -> monthly spend limit $50. Confirm it is set before launch.
6. **Rotate the Supabase service role key** (Project Settings -> API ->
   rotate), then update `SUPABASE_SERVICE_ROLE_KEY` in Vercel and in Landen's
   `.env.local`. The old key was used in scratch scripts on 08-21.
7. **Go-live keys** per `docs/GO-LIVE-WIRING.md`: Stripe live keys and price
   ids, `NEXT_PUBLIC_SITE_URL` = the real domain (no trailing slash),
   `ANTHROPIC_API_KEY` (Sensitive), `NEXT_PUBLIC_APPLE_SIGNIN=1`, delete
   `GEMINI_API_KEY` everywhere. One value per field; do not paste
   instruction text into Vercel.
8. **Supabase Auth URL config** on the real domain: Site URL and redirect
   allowlist (`https://<domain>/**`), keep `http://localhost:3000/**` for dev.
9. **CLI migration baseline** per `supabase/MIGRATIONS.md`, so live schema
   changes stop being dashboard pastes.

## Soon after launch

10. Vercel Pro (crons: main declares 17, Hobby allows 2) and Supabase Pro
    (backups, no pausing).
11. Apple Sign in: the client secret JWT in Supabase expires 2027-02-20.
    Calendar reminder for mid-January 2027 to regenerate
    (`C:\Users\lande\apple-secret\make-secret.js`, needs the .p8). Also
    rotate the Apple key `34UDQ3MTXM`: it was pasted into a chat on 08-21.
12. Register OakTend's sending domain for Apple private relay email (Apple
    portal -> Services -> Sign in with Apple for Email Communication) once
    Resend is live, or Hide-My-Email users never get mail.
13. Block disposable email domains at signup (Supabase has no built-in list;
    smallest option is a deny-list check in the signup server action).
14. **Twilio for SMS.** Trial account exists (number +1 737 258 3478, keys in
    Landen's `.env.local`, add the three `TWILIO_*` vars to Vercel). Before
    texting anyone but verified numbers: upgrade the account (adds a card)
    and register a 10DLC brand + campaign (or verify a toll-free number);
    carriers take days to approve. Then set `TWILIO_WEBHOOK_URL` per
    `docs/GO-LIVE-WIRING.md` so inbound STOP/replies verify.
