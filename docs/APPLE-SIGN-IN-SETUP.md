# Sign in with Apple - manual setup

Written 2026-08-19. The code is done and shipped: `src/components/AppleSignInButton.tsx` sits
directly under the Google button on `/signin`, `/homeowner-signup`, and `/contractor-signup`.
Nothing below needs code changes. It is all Apple Developer portal and Supabase dashboard work
that only the account owner (Landen) can do.

## Why bother now

App Store Review Guideline 4.8 ("Login Services") requires an equivalent Apple login option in
any app that offers a third-party or social login such as Google. Hearth already offers Google.
So the day a Hearth iOS app is submitted, a missing Apple option is an automatic rejection.

Doing it on web first is the cheap version of that work: the Apple Developer account, the App ID,
the Services ID, and the signing key are the same artifacts an iOS submission needs later. Getting
them created and wired into Supabase now means the future iOS build inherits a working provider
instead of starting the clock on a rejection loop.

## Failure mode before it is configured

Until the Apple provider is enabled in Supabase, the button is harmless. It calls
`supabase.auth.signInWithOAuth({ provider: "apple" })`, Supabase's auth server answers with a
"provider is not enabled" error, `signInWithOAuth` returns that as `{ error }` instead of
navigating the browser anywhere, and the button hands the message to the page's existing
`onError` callback. That renders in the same red error box the email/password form already uses.
The button re-enables itself, the page stays put, nothing crashes, nothing half-signs-in.

Harmless, but still a dead button on the app's three most important pages, so it is not shown at
all until `NEXT_PUBLIC_APPLE_SIGNIN=1` (see step 4). The fallback above is the safety net for a
provider that breaks after being switched on - an expired secret, say - not the normal
pre-configuration state.

## What you need before starting

- An Apple Developer Program membership: $99/year, individual or organization. Enrollment can take
  anywhere from a few hours to a couple of days if Apple wants ID verification, so start there.
  Sign in at https://developer.apple.com/account and enroll if you have not.
- Your Supabase project ref (the subdomain in your Supabase URL, e.g. the `abcdefghij` in
  `https://abcdefghij.supabase.co`). It is in `.env.local` as part of
  `NEXT_PUBLIC_SUPABASE_URL`, and in the Supabase dashboard under Project Settings > General.
- Your production domain (the one Hearth is actually served from). Apple will not accept a
  localhost or a raw Vercel preview URL as a registered web domain, so do this against the real
  domain once it is live.

## Step 1 - Create an App ID

In the Apple Developer portal: Certificates, Identifiers & Profiles > Identifiers > the blue "+".

1. Choose "App IDs", then "App".
2. Description: `Hearth`. Bundle ID: explicit, reverse-DNS, something like
   `com.yourdomain.hearth`. Write this down - the Services ID in step 2 must be different from
   it, and a future iOS app must use exactly this one.
3. In the Capabilities list, tick "Sign in with Apple". Leave it on the default "Enable as a
   primary App ID".
4. Register.

## Step 2 - Create a Services ID (this is the web client)

Same Identifiers screen, "+" again.

1. Choose "Services IDs".
2. Description: `Hearth Web`. Identifier: something like `com.yourdomain.hearth.web`. It must NOT
   equal the App ID from step 1.
3. Register, then click back into the new Services ID to configure it.
4. Tick "Sign in with Apple", then click "Configure".
5. Primary App ID: the App ID from step 1.
6. Domains and Subdomains: your production domain, no scheme and no trailing slash, e.g.
   `hearth.example.com`.
7. Return URLs: the Supabase callback, exactly:

   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

   Substitute your real project ref. This is the Supabase URL, NOT a Hearth URL and NOT
   `/auth/callback` on your own domain. Apple redirects to Supabase, Supabase finishes the
   exchange and then sends the browser to Hearth's own `/auth/callback?code=...`, which is
   where `src/app/auth/callback/route.ts` takes over. Getting this wrong is the single most
   common cause of an `invalid_client` error.
8. Save, then Continue/Save on the outer screen too. Apple sometimes silently drops the domain
   if you skip the outer save - go back in afterwards and confirm both fields stuck.

   Note: this Services ID identifier is your OAuth "client ID" for the web. Keep it handy for
   step 4.

## Step 3 - Create the .p8 signing key

Certificates, Identifiers & Profiles > Keys > "+".

1. Key Name: `Hearth Sign in with Apple`.
2. Tick "Sign in with Apple", click Configure, choose the App ID from step 1 as the primary,
   Save.
3. Continue, Register, then Download. You get an `AuthKey_XXXXXXXXXX.p8` file.

   **Apple lets you download this exactly once.** Save it somewhere durable and private (a
   password manager entry or an encrypted vault, not the repo, not Downloads, and never
   committed to git). If you lose it, the only fix is to revoke the key and make a new one.

4. Note the Key ID (the 10-character `XXXXXXXXXX` in the filename, also shown on the key page)
   and your Team ID (top right of the developer portal, also 10 characters).

At this point you should have four things written down:

| Thing | Looks like | Where it came from |
| --- | --- | --- |
| Services ID | `com.yourdomain.hearth.web` | Step 2 |
| Team ID | `A1B2C3D4E5` | Portal header / Membership page |
| Key ID | `F6G7H8I9J0` | Step 3 |
| Private key | `-----BEGIN PRIVATE KEY-----...` | Contents of the .p8 file |

## Step 4 - Enable the provider in Supabase

Supabase dashboard > your project > Authentication > Sign In / Providers > Apple. Toggle it on.

Fill in the fields the dashboard asks for. As of August 2026 (checked against
https://supabase.com/docs/guides/auth/social-login/auth-apple), Supabase does NOT generate or
rotate the secret for you. The form asks for two things:

- **Client IDs**: a comma-separated list. Put the Services ID from step 2 FIRST - Supabase uses
  the first entry as the client id for the web `signInWithOAuth` flow. (A future iOS app's bundle
  ID gets appended to this same list later; order matters, web stays first.)
- **Secret Key (for OAuth)**: Apple's client secret is not a static string - it is an ES256 JWT
  you sign with the .p8 key, and Apple caps its lifetime at **six months**. The Supabase docs page
  above embeds a browser-based generator: paste in your Team ID, Services ID, Key ID, and the .p8
  contents and it produces the JWT locally ("no keys leave your browser"; the tool is known not to
  work in Safari - use Chrome). Paste the resulting JWT into this field.

**The six-month trap:** when that JWT expires, every Apple sign-in on Hearth starts failing
SILENTLY - Supabase shows no warning and sends no email. Set a recurring calendar reminder for
five months out, titled "Regenerate Apple client secret JWT and repaste into Supabase", and keep
the .p8 plus these four values in your password manager so regeneration takes two minutes. If the
dashboard someday grows fields for the raw .p8/Team ID/Key ID (meaning Supabase started minting
the secret itself), switch to that and delete the reminder.

Also on that screen, note the callback URL Supabase displays. Confirm it character-for-character
matches what you put in the Services ID's Return URLs in step 2.

Finally, under Authentication > URL Configuration, make sure your production domain is in the
Site URL / Redirect URLs allow list. It already needs to be for Google, so it probably is.

Then set `NEXT_PUBLIC_APPLE_SIGNIN=1` in Vercel (Settings > Environment Variables) and redeploy -
the "Continue with Apple" button is hidden everywhere until that value is exactly `1`.

## Step 5 - Verify

1. Open `/signin` on the production domain in a private window. Click "Continue with Apple".
2. You should reach Apple's own sign-in screen, not a red error box. If you get
   `invalid_client`, the Services ID or the Return URL is wrong (step 2). If you get "provider is
   not enabled", step 4 did not save. If you get an expired-secret error months later, that is
   Mode B biting - regenerate the JWT.
3. Complete the sign-in. You should land back on Hearth, signed in, at `/welcome/role` (a brand
   new account with no role picks one there) or at your `?next=` destination.
4. Repeat once from `/homeowner-signup` and once from `/contractor-signup` with a second Apple ID,
   and confirm each lands in the right onboarding. Those pages point the button at
   `/onboarding` and `/pro/onboarding` respectively, which is how
   `src/app/auth/callback/route.ts` decides whether to stamp the new user `homeowner` or
   `contractor`.
5. Try the "Hide My Email" option on at least one test sign-in. Those users arrive with a
   `@privaterelay.appleid.com` address. The account works fine, but see step 6 before trusting
   that email to those users actually arrives.

Local development note: Apple refuses localhost as a Services ID domain, but that mostly does not
matter here - the Return URL registered with Apple is SUPABASE's callback, not Hearth's. Apple
redirects to Supabase, and Supabase then redirects to whatever `redirectTo` the button passed. So
Apple sign-in works from `npm run dev` as long as `http://localhost:3000/**` is in the Supabase
Redirect URLs allow list (Authentication > URL Configuration).

## Step 6 - Register Hearth's email senders for private relay (before email goes live)

Apple's private relay (`@privaterelay.appleid.com`) only forwards mail from senders the app's
developer account has registered. Anything else bounces with `550 5.1.1 unauthorized sender`.
In the Apple Developer portal, under Services > "Sign in with Apple for Email Communication",
register Hearth's sending domain AND every from-address (the Resend domain/addresses once
GO-LIVE-WIRING happens), and make sure SPF/DKIM pass for them. Do this as part of turning Resend
on, or every "Hide My Email" user silently never gets reminders, receipts, or confirmations.

## One behavior worth knowing

Apple returns a user's name and email **only on the very first authorization** of Hearth by that
Apple ID. Every subsequent sign-in returns the identity token alone. So if you delete a test user
from Supabase and sign in again with the same Apple ID, the account comes back with no name
attached, and there is no way to make Apple resend it except by revoking Hearth under
Settings > Apple ID > Sign in with Apple on the device, then signing in again.

This is not a bug in Hearth and needs no code handling: the callback's `full_name` backfill simply
has nothing to copy for those users, exactly like any other account that arrives without a name,
and onboarding asks for the name directly anyway (it needs it for the county ownership-of-record
match). Just do not be confused by it while testing.
