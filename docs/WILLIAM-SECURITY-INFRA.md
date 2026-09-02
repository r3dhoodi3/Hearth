# William: security and infra list

Owner: William (security/infra go-live work, per Landen 2026-08-21). Landen keeps
the owner-only account and money items. Items are ordered by impact. Each one is
a dashboard setting or a paste, not code; the code-level protections are already
in the repo.

## Status update 2026-09-01 (read this first)

Where things stand as of tonight, so the list below reads against reality:

- **Live DB is fully current through migration 0153** (verified in the SQL
  editor: big-job insurance gate live in both charge functions, repeat bug
  reports unblocked). No SQL pastes are owed right now.
- **A production redeploy on 09-01 activated env vars that had been sitting
  unapplied**: `ANTHROPIC_API_KEY` (re-entered as a shared variable), the
  three VAPID push keys, `RISK_HASH_SALT`, `RISK_ENFORCE`. Env edits in
  Vercel do nothing until a redeploy; that is what had Ask Hearth down.
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
   the Hearth domain). The secret goes in Supabase; the site key goes in
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
12. Register Hearth's sending domain for Apple private relay email (Apple
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
