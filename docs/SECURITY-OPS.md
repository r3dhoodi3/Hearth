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
- [ ] Supabase: CAPTCHA enabled (and the token wired into the auth forms)
- [ ] Supabase: rate limits lowered, anonymous sign-ins off
- [ ] Twilio: Geo Permissions restricted to US and CA
- [ ] Twilio: spend alert set
