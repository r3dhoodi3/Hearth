# Security operations

Settings that live in a vendor dashboard, not in this repo. Code cannot turn
these on, and none of them are on by default, so each one is a real gap until
somebody clicks it. Everything here is a one-time change; re-check after any
Supabase or Twilio project migration, because a restored or re-created project
comes back with defaults.

Written 2026-08-26 alongside migration 0132. See `docs/GO-LIVE-WIRING.md` for
environment variables and `docs/deploy-runbook.md` for the deploy sequence.

## Supabase Auth

### 1. Secure password change (do this one first)

**Where**: Supabase dashboard, Authentication, Providers, Email, "Secure
password change".

**What it does**: requires the current password (or a fresh re-authentication)
before `updateUser({ password })` will change a password.

**Why it matters**: without it, holding a session is the whole requirement to
change a password. An unattended laptop, a shared machine, or a borrowed
session becomes a full account takeover - the attacker sets a new password,
and the real owner is locked out of their own account with no way back except
support.

The app now carries its own half of this fix: `/reset-password?step=update`
renders the "set a new password" form only when a short-lived, httpOnly
`hearth_pwrecovery` cookie is present, and that cookie is only ever set by
`/auth/callback` or `/auth/confirm` after a successful recovery exchange (see
`src/lib/passwordRecovery.ts`). That closes the walk-up through our own page.
It does not close the API: `supabase.auth.updateUser` is callable directly from
any signed-in session. Only this setting closes that.

### 1b. Make the reset email carry `type=recovery` (verify this after deploying)

The cookie above is set on exactly one signal: `?type=recovery` on the request
that lands back on our site. It deliberately does not infer recovery from
`?next=`, because `next` is caller-supplied on every sign-in and would make the
cookie mintable by anyone completing an ordinary OAuth sign-in with a chosen
query string.

So the reset link has to carry that parameter through to us. **Test the whole
flow once against production**: request a reset, click the emailed link, and
confirm the "Set a new password" form appears rather than the "enter your
email" step. If it shows step one instead, the parameter is not arriving, and
the fix is to set the **Reset Password** email template (Authentication, Email
Templates) to the confirm-route form, which carries it by construction:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password?step=update
```

`src/app/auth/confirm/route.ts` already handles that shape and sets the cookie
on `type === "recovery"`.

**Update, 2026-08-29.** The app no longer waits for Supabase to add that
parameter: `passwordRecoveryRedirectTo()` in `src/lib/passwordRecovery.ts` puts
`type=recovery` on the `redirectTo` we hand `resetPasswordForEmail`, so the
default PKCE link carries it by construction. Two things still need the owner:

1. **The redirect allow-list has to accept it.** Authentication, URL
   Configuration: Site URL = the real domain, no trailing slash, and Redirect
   URLs must include `https://<domain>/**` (the `**` matters - the reset link
   now carries a query string). Keep `http://localhost:3000/**` for dev. If the
   URL is not allow-listed Supabase silently falls back to the Site URL and the
   click lands on the home page instead of the reset form.
2. **Cross-device clicks still need the confirm-route template.** The default
   link is a PKCE code, and the code_verifier lives only in the browser that
   asked for the reset. Request the reset on a laptop, open the email on a
   phone, and the exchange fails - the phone lands on `/signin` with the "try
   signing in" notice (which now also shows for `?error=link_invalid`, it used
   to show nothing at all). The `token_hash` template above has no verifier and
   works on any device, which is why it is still the recommended setting.

### 1c. Link expiry

**Where**: Authentication, Email Templates / Providers, "Email OTP Expiration"
(some dashboards label it Advanced settings, `MAILER_OTP_EXP`). It governs how
long a recovery link stays valid. Default is 3600 seconds (1 hour); 3600 or less
is the recommendation, and it must not be raised. A reset link is a bearer
credential sitting in a mailbox.

Two other expiries stack on top of it and are already fixed in code, so nothing
to click:

- The `hearth_pwrecovery` cookie is 15 minutes (`src/lib/passwordRecovery.ts`),
  so the "set a new password" form is only reachable for 15 minutes after the
  click, and `src/app/reset-password/actions.ts` clears it the moment the
  password actually changes. One emailed link, one password change.
- Supabase invalidates a recovery token once it has been used.

### 2. CAPTCHA on auth endpoints

**Where**: Authentication, Settings, "Enable CAPTCHA protection" (hCaptcha or
Cloudflare Turnstile). The site key then has to be wired into the sign-in and
sign-up forms.

**Why**: sign-in, sign-up and password-reset are all unauthenticated endpoints
that accept an email address. Without a CAPTCHA they are free to script:
credential stuffing against sign-in, and reset-link floods aimed at a real
customer's inbox. Sign-up in particular is what the free-trial abuse work in
migration 0130 exists to clean up after; a CAPTCHA is the cheaper half of that,
applied before the account exists.

Note this is the one item here that needs a code change too (passing the token
through to `signInWithPassword` / `signUp` / `resetPasswordForEmail`), so it is
not purely a dashboard click.

### 3. Tighten the auth rate limits

**Where**: Authentication, Rate Limits.

The defaults are generous because they are sized for a large project. Hearth is
one county. Bring them down to something a real person cannot notice and a
script cannot live with:

- Sign-in / token: enough for a person who mistypes a few times, not enough for
  a dictionary run.
- Email sends (confirmation, recovery, magic link): low. Every one of these
  costs a real customer's inbox, and the reset flow already tells the user "a
  link is on its way" whether or not one was sent, so a lower cap changes
  nothing a legitimate user sees.
- Anonymous sign-ins: zero unless a feature starts using them. Nothing in this
  app does.

Set a number, then watch the auth logs for a week for legitimate users hitting
it. Too low is visible and fixable; too high is invisible.

### 3b. Session expiry

**Where**: Authentication, Sessions.

**The problem in one line**: the access token expires in an hour, the refresh
token does not expire at all by default, and `@supabase/ssr` stores it in a
cookie with a 400-day Max-Age. So a phone or a laptop that signed in once stays
signed in indefinitely, minting a fresh access token on every visit. That is
what "tokens work forever" means here, and no amount of code in this repo
changes it: only this screen does.

Set, in order of value:

- **Time-box sessions**: on. A session is force-ended after a fixed lifetime no
  matter how active it is. 30 days is a sensible number for both sides of the
  app: it matches the app-side idle rule below, and a re-sign-in once a month is
  not something a homeowner notices.
- **Inactivity timeout**: on, 30 days. This is the dashboard twin of the app
  rule below. Belt and braces on purpose: this one is enforced by Supabase and
  survives any change to our middleware.
- **Refresh token rotation**: on. Each refresh issues a new refresh token and
  retires the old one, so a stolen token is usable once, not forever.
- **Reuse interval / reuse detection**: leave the small interval (10 seconds is
  the default) and make sure detection is on. When an already-used refresh token
  comes back outside that window, Supabase revokes the whole family - which is
  the only automatic signal we get that a token was copied off a device.
- **JWT expiry**: leave at 3600 seconds. Shorter costs a refresh round trip on
  every page; longer widens the window a leaked access token is good for.

Both of the timeout settings are plan-dependent on some Supabase tiers. If they
are greyed out, the app-side rule below is the whole protection until the
project is upgraded, and it is worth upgrading for.

**What the app already does, so this is not the only line of defence.**
`src/lib/sessionActivity.ts` plus the check in
`src/lib/supabase/middleware.ts` end a session that has gone 30 days without a
single signed-in request: the middleware calls `signOut()` (which revokes the
refresh token at Supabase, not just locally), clears the auth cookies, and lands
the person on `/signin?expired=1` with a plain "you were signed out because this
device had not used Hearth in a while". The stamp lives in one httpOnly cookie
(`hearth_seen`), written at most once an hour, and `/auth/signout` clears it
along with the session.

**Also on that screen, worth knowing**: "Sign out other devices" in the app
(Account, Security, and the pro Profile's Account Security tab) calls
`signOut({ scope: "others" })`, which revokes every other refresh token and
keeps the current one. That is the user-facing kill switch if a phone is lost.

## Twilio

### 4. Geo Permissions: US and CA only

**Where**: Twilio Console, Messaging, Settings, Geo Permissions. Turn
**everything** off except United States and Canada.

**Why**: Geo Permissions is an account-wide allowlist of destination countries,
and by default a long list is enabled. Any path that reaches
`messages.create()` with an attacker-chosen destination becomes international
premium-rate SMS billed to this account - the classic toll-fraud pattern, and
it can run up a serious bill in an hour. The app validates destination numbers
as US/CA E.164 before sending, which is the right check in the right place, but
it is one code path away from being bypassed and Geo Permissions is enforced by
Twilio no matter what we send.

Hearth serves Orange County, California. There is no legitimate reason for this
account to be able to text another country.

While in that console, also confirm:

- A messaging-service-level rate limit or a spend alert is set, so a runaway
  loop is capped in dollars as well as in code.
- The auth token in Vercel matches the one in the console, and no old token is
  still active.

## Checklist

- [ ] Supabase: Secure password change enabled
- [ ] Supabase: reset link verified end to end in production (step 1b)
- [ ] Supabase: Site URL + Redirect URLs allow-list the real domain with `/**`
- [ ] Supabase: email OTP expiry 3600 seconds or less (step 1c)
- [ ] Supabase: CAPTCHA enabled (and the token wired into the auth forms)
- [ ] Supabase: rate limits lowered, anonymous sign-ins off
- [ ] Supabase: sessions time-boxed + inactivity timeout, refresh rotation and
      reuse detection on (step 3b)
- [ ] Twilio: Geo Permissions restricted to US and CA
- [ ] Twilio: spend alert set
