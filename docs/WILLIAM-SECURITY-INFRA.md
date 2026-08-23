# William: security and infra list

Owner: William (security/infra go-live work, per Landen 2026-08-21). Landen keeps
the owner-only account and money items. Items are ordered by impact. Each one is
a dashboard setting or a paste, not code; the code-level protections are already
in the repo.

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
