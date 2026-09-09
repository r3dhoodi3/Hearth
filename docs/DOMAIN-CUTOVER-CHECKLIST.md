# Domain cutover checklist: gethearth.vercel.app to oaktend.com

Owner: Landen (business, DNS, vendor dashboards) and William (Vercel, engineering config).
Claude does the code-only step (step 4) and nothing else in this list.

This is an ordered, step-by-step runbook. Do the steps in order. Each step has an owner, a
verification, and a rollback. Do not skip verification to save time: a bad DNS or auth-redirect
change here breaks sign-in and checkout for every user, not just new ones.

## Before you start (preconditions)

- The LLC does not need to exist yet for this cutover. `src/lib/legal.ts` already renders
  `[TODO(legal): ...]` placeholders where the legal entity name and address are unset, and that
  is expected to keep rendering until the LLC paperwork is done separately. Domain cutover and
  legal-entity paperwork are independent tracks.
- Cloudflare Email Routing for `hello@`, `support@`, `legal@`, `privacy@`, `security@` at
  `oaktend.com` must already be set up and receiving mail before step 3, because step 3 switches
  the app's outbound sender and reply-to addresses to those mailboxes. Sending mail "from" an
  address nobody can receive replies at is a support failure waiting to happen. If this is not
  done yet, do it first (see the OakTend email setup reminder) and confirm a test email lands
  before proceeding past step 3.
- The three local commits on `main` (`553c6f4` legal wave, `f228445` brand rename, `7ff1e60`
  fixes) are reviewed and ready to push. `git log --oneline` on this machine shows these three
  are ahead of `origin/main` by exactly 3 commits as of this writing.
- Landen and William have agreed on a rollback point: if anything in steps 2-3 goes badly wrong,
  the fallback is to leave `gethearth.vercel.app` as the primary domain and delay the cutover,
  not to rush a fix live.

---

## Step 1: push the three local commits

**Owner: [William]**

1. Push `main` to `origin/main`. This carries commits `553c6f4`, `f228445`, `7ff1e60` (legal
   pages, the Hearth-to-OakTend brand rename, and the post-rename fixes) live. Vercel will
   deploy automatically on push.
2. Wait for the Vercel deployment to finish and go to Ready.

**Verify:** open `https://gethearth.vercel.app` and confirm the header, footer, and page titles
say "OakTend", not "Hearth". Run the app's test suite locally first if there is any doubt
(`npm test` or the project's usual command) so a broken deploy is caught before anyone touches
DNS.

**Rollback:** revert the Vercel deployment to the previous one from the Vercel dashboard
(Deployments tab, pick the prior deployment, "Promote to Production"). This does not touch DNS or
any vendor dashboard, so it is safe and fast.

---

## Step 2: add the domain in Vercel and point DNS at it

**Owner: [William]** adds the domain in Vercel. **[Landen]** adds the DNS records in Cloudflare.

1. **[William]** In the Vercel project, Settings > Domains, add `oaktend.com` and
   `www.oaktend.com`. Vercel will show the DNS records it wants.
2. **[Landen]** In Cloudflare DNS for `oaktend.com`:
   - Add an `A` record: name `@` (apex), value `76.76.21.21`.
   - Add a `CNAME` record: name `www`, value `cname.vercel-dns.com`.
   - Set both records to **DNS only** (grey cloud, proxy off). Do not turn the orange cloud
     (Cloudflare proxying) on for either record. See the "do not do" list below for why.
3. Set `oaktend.com` as the Primary Domain in Vercel's domain settings, with `www.oaktend.com`
   redirecting to it (or the reverse, whichever Landen and William prefer for the canonical
   form; pick one and keep it consistent with `NEXT_PUBLIC_SITE_URL` in step 3).

**Verify:** DNS propagation can take minutes to a couple of hours. Check with
`nslookup oaktend.com` or https://dnschecker.org until it resolves to Vercel's IP. Once it
resolves, Vercel will auto-issue an SSL certificate; the Domains tab in Vercel shows a green
"Valid Configuration" once that is done. Load `https://oaktend.com` in a browser and confirm it
serves the same site as `gethearth.vercel.app` (it will still say "OakTend" but env vars are not
updated yet, so canonical URLs, sitemap, and emails will still reference the old domain until
step 3).

**Rollback:** remove the domain from the Vercel project and delete the two DNS records in
Cloudflare. `gethearth.vercel.app` keeps working the entire time this step is in progress,
because nothing about it changes until step 3 flips the primary-domain env var.

---

## Step 3: update every vendor's URL configuration

**Owner: [William]** for Vercel env vars and Stripe/webhook wiring. **[Landen]** for Supabase
Auth, Apple, Google, and Resend dashboards (these are the accounts only the owner has access to
in this project's current setup; William can drive if Landen shares access).

Do these together, in order, since a partial update (e.g. Stripe webhook updated but Supabase
Auth redirect not yet) can produce confusing failures for whoever is testing in between.

1. **[William]** In Vercel, set `NEXT_PUBLIC_SITE_URL=https://oaktend.com` (no trailing slash)
   on Production. This one env var drives canonical URLs, the sitemap, robots.txt, OG tags,
   `security.txt`, JSON-LD, and (via `src/lib/legal.ts`) the default `legal@`, `support@`,
   `privacy@`, `security@` addresses, since none of those are hardcoded (see the reference list
   at the end of this doc). Redeploy after setting it (env var changes need a redeploy to take
   effect at build time for some of these).
2. **[Landen]** In Supabase, Authentication > URL Configuration:
   - Set Site URL to `https://oaktend.com`.
   - Add `https://oaktend.com/auth/callback` and `https://oaktend.com/auth/confirm` to the
     Redirect URLs allow list. Leave the `gethearth.vercel.app` ones in place for now (see the
     "keep the old domain redirecting" section below); remove them only after the smoke test in
     step 7 passes and a few days have gone by with no traffic hitting the old ones.
3. **[Landen]** Apple Developer portal (see `docs/APPLE-SIGN-IN-SETUP.md` for the fuller
   walkthrough of this screen): on the Services ID used for Sign in with Apple, update the
   registered domain and the Return URLs to `oaktend.com` and
   `https://oaktend.com/auth/callback` (through Supabase's own callback path per that doc's
   instructions). Apple requires domain verification (a file served at
   `.well-known/apple-developer-domain-association.txt`); redo that verification for the new
   domain before removing it from the old one.
4. **[Landen]** Google Cloud Console, the OAuth client used for Google sign-in: add
   `https://oaktend.com` to Authorized JavaScript origins and
   `https://oaktend.com/auth/callback` (or Supabase's own OAuth callback URL, whichever the
   client is configured to use) to Authorized redirect URIs. Leave the old ones in place until
   after step 7's smoke test.
5. **[William]** Stripe dashboard, Developers > Webhooks: add a new endpoint at
   `https://oaktend.com/api/stripe/webhook`, copy its new signing secret, and set
   `STRIPE_WEBHOOK_SECRET` in Vercel to that new value. The webhook handler fails closed if this
   secret is missing or wrong (`src/app/api/stripe/webhook/route.ts` line ~1413-1424 rejects the
   request before doing anything), so this is safe to get wrong temporarily: it just means
   webhooks silently fail until fixed, not that bad data gets processed. Do not delete the old
   webhook endpoint yet; disable it after step 7 confirms the new one is receiving events.
6. **[Landen]** Resend dashboard: add `oaktend.com` as a sending domain, add the DNS records
   Resend gives you (DKIM, SPF or return-path via the MX record it specifies, and DMARC) in
   Cloudflare DNS, and wait for Resend to show the domain as Verified. Only after it is verified,
   update `RESEND_FROM` in Vercel to an address on the new domain, e.g.
   `OakTend <hello@oaktend.com>`. Do this after Cloudflare Email Routing (the precondition above)
   is confirmed working, since `RESEND_FROM`'s address and the Email Routing mailbox should be
   the same address family so replies land somewhere real.

**Verify:** after each sub-step, check that vendor's dashboard shows the new URL saved (Supabase,
Apple, Google, Stripe, Resend all show a confirmation state, not just an input field with text in
it). After all of them: sign in with email, Apple, and Google against `oaktend.com` in a private
browser window (full smoke test is step 7, but a quick pass here catches an obviously wrong
redirect URL before moving on).

**Rollback:** every one of these is a URL entry, not a data migration. Revert the vendor
dashboard field back to the `gethearth.vercel.app` value and, if you already deployed
`NEXT_PUBLIC_SITE_URL=https://oaktend.com`, redeploy with it set back to
`https://gethearth.vercel.app`. Because the old domain keeps working through this whole cutover
(see the "keep the old domain redirecting" note), a rollback here has no user-facing outage.

---

## Step 4: swap remaining hardcoded references in code

**Owner: [Claude]**

Everything in `src/lib/legal.ts` and the pages that import `SITE_URL` from
`process.env.NEXT_PUBLIC_SITE_URL` already update automatically once step 3's env var changes;
that is most of the codebase's URL surface and needs no code edit. What is left is a short list
of places that hardcode `gethearth.vercel.app` in test fixtures and one place with a stale,
never-owned `hearth.build` reference in an HTTP User-Agent string. See the "code references
found" section at the end of this document for the exact list with current and target strings.
This is a fourth commit, separate from the three pushed in step 1, made after step 3 so the
target domain is confirmed correct.

**Verify:** run the test suite (`npm test` or the project's usual command). The test files listed
below assert against a literal `gethearth.vercel.app` string; updating those strings must not
break the tests they belong to (they test origin-matching logic generically, so the literal value
does not matter to the logic, only to the fixture).

**Rollback:** this is a normal code commit; revert it with `git revert` if something regresses.

---

## Step 5: apply the pending SQL migration

**Owner: [Landen]**

1. Open the Supabase SQL editor for the production project.
2. Paste and run `supabase/PASTE-ME-ALL-PENDING-2026-09-03.sql` (migration 0154). It has a
   precheck at the top that raises an exception if it has already been applied or if a
   prerequisite migration is missing, so it is safe to run and safe to re-run by accident.

**Verify:** the SQL editor shows success with no exception raised. Spot-check one table or column
the migration touches to confirm the change is live.

**Rollback:** if the migration fails partway, read the raised exception; these migrations are
written to fail before making partial changes. If it succeeded but needs to be undone, that needs
a hand-written down-migration; there is no generic rollback for a schema change.

---

## Step 6: rename Stripe products and check for a stray brand override

**Owner: [Landen]**

1. In the Stripe dashboard, rename the products currently called "Hearth Plus" and "Hearth Pro"
   to "OakTend Plus" and "OakTend Pro" (or whatever the current product names should be). This is
   a display-name change only; it does not affect price IDs, so no code or env var changes are
   needed for this part.
2. In Vercel, confirm `NEXT_PUBLIC_LEGAL_BRAND` is either unset or set to `OakTend`, not left over
   as `Hearth` from an earlier setup. `src/lib/legal.ts` falls back to `"OakTend"` when unset, so
   an unset value is fine; an explicit `Hearth` value would silently override the rename.
3. Optional: rename the Vercel project and the Supabase project (both are cosmetic, dashboard-only
   renames that do not affect URLs, API keys, or connection strings).

**Verify:** Stripe checkout (test mode) shows the new product name on the checkout page. The
billing page and any receipt/invoice email shows "OakTend", not "Hearth".

**Rollback:** rename back in the Stripe dashboard; no data is affected by a product display-name
change.

---

## Step 7: post-cutover smoke test

**Owner: [Landen] and [William] together**, ideally both present so one can watch logs while the
other clicks through the app.

Run all of these against `https://oaktend.com` in a private/incognito window (avoid stale
cookies or a cached service worker from testing):

1. Sign in with email and password.
2. Sign in with Apple.
3. Sign in with Google.
4. Start a Stripe checkout in test mode (homeowner Plus or Pro plan) and confirm it reaches
   Stripe's hosted checkout page without the "we couldn't start checkout" error.
5. Trigger a transactional email (password reset, or any notify.ts path) and confirm it arrives
   with a `From` address on `oaktend.com`, not `gethearth.vercel.app` or Resend's sandbox sender.
6. Trigger a push notification (any path that calls `sendPush`, e.g. a test lead notification)
   and confirm it shows up on a device with notifications enabled for `oaktend.com`.
7. Send an SMS opt-in link (Twilio) and confirm the link in the message resolves to
   `oaktend.com`, not the old domain.
8. Load `/robots.txt`, `/sitemap.xml`, and `/.well-known/security.txt` and confirm every URL in
   them says `oaktend.com`.
9. View source on the homepage and confirm the Open Graph image and canonical `<link>` tag both
   point at `oaktend.com`.

**Rollback:** if any of these fail, do not proceed to disabling the old domain's fallback
listeners (Stripe's old webhook, Supabase's old redirect URLs, Apple/Google's old origins). Fix
forward on `oaktend.com` while the old domain's config stays live as a safety net.

---

## Keep the old domain working as a redirect

Once `oaktend.com` is the Primary Domain in Vercel (step 2), Vercel automatically 301-redirects
`gethearth.vercel.app` to `oaktend.com` for every request. No extra config is needed for this.

**Verify it:** `curl -I https://gethearth.vercel.app` and confirm the response is a `308` or
`301` with a `Location: https://oaktend.com/...` header, not a `200`.

Do not delete the `gethearth.vercel.app` domain from the Vercel project. Leaving it attached is
what makes the automatic redirect work; removing it would make old links, old bookmarks, and any
installed PWA still pointed at the old origin simply break instead of forwarding.

## PWA and push notification considerations

- Anyone who installed the app to their home screen from `gethearth.vercel.app` has a service
  worker (`public/sw.js`) registered against that origin, not `oaktend.com`. A domain redirect
  does not move an installed PWA or re-register its service worker; the installed icon will keep
  opening `gethearth.vercel.app`, which will now redirect into `oaktend.com` inside that PWA
  shell. This mostly self-heals on next full navigation, but the cleanest fix for a user who
  reports a stale-looking icon or a broken push is to remove and reinstall the app from
  `oaktend.com`.
- Web Push subscriptions are created per-origin by the browser (see
  `src/components/PushRegistrar.tsx` and `src/lib/push.ts`, which reads
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`). A subscription created
  while someone was on `gethearth.vercel.app` is tied to that origin's service worker
  registration and will not automatically carry over to `oaktend.com`; the VAPID keypair itself
  does not need to change (it identifies the app server, not the origin), but each browser needs
  to visit `oaktend.com` at least once, with notification permission granted again, to get a new
  subscription recorded against the new origin. Expect a period where some users stop receiving
  push until they reopen the app on the new domain. Consider a one-time in-app banner asking
  people to re-enable notifications if the drop-off looks significant after cutover.

## Do not do

- Do not turn on the Cloudflare orange cloud (proxying) for the `oaktend.com` DNS records that
  point at Vercel. Vercel needs to terminate TLS and see the real client IP directly; proxying
  through Cloudflare in front of Vercel breaks Vercel's own SSL certificate issuance and can
  break IP-based rate limiting in the app. Keep both records DNS only (grey cloud).
- Do not delete the `gethearth.vercel.app` domain from the Vercel project. It is what keeps the
  automatic redirect alive for old links and installed PWAs.
- Do not rename the `hearth_*` prefixed storage keys, cookies, or localStorage keys anywhere in
  the codebase (for example the `hearth_pwrecovery` cookie referenced in
  `src/app/auth/callback/route.ts` and `src/lib/passwordRecovery.ts`, and `src/lib/requestOrigin.ts`).
  These are internal identifiers, not user-facing brand text, and renaming them mid-cutover risks
  breaking a cookie-matching check somewhere for no visible benefit. Leave them exactly as they
  are.

---

## Code references found for step 4

These are the exact places `gethearth.vercel.app` and one stale `hearth.build` reference appear
in the codebase as of this checklist being written. `src/lib/legal.ts` and every page that reads
`process.env.NEXT_PUBLIC_SITE_URL` are NOT in this list because they already resolve to whatever
`NEXT_PUBLIC_SITE_URL` is set to in step 3 and need no code change.

### `gethearth.vercel.app` (test fixtures; safe to update, low risk)

| File | Line(s) | Current | Target |
|---|---|---|---|
| `src/app/reset-password/stepGating.test.tsx` | 123, 127 | `"https://gethearth.vercel.app"` | `"https://oaktend.com"` |
| `src/app/api/tax-appeal/route.test.ts` | 20, 23, 187, 190 | `"https://gethearth.vercel.app/api/tax-appeal"` and `host: "gethearth.vercel.app"` | `"https://oaktend.com/api/tax-appeal"` and `host: "oaktend.com"` |
| `src/lib/csrf.test.ts` | 5, 16-17, 27, 36, 48, 60-61, 71-72, 81, 91, 96, 105, 112 | multiple `host: "gethearth.vercel.app"` / `origin: "https://gethearth.vercel.app"` fixtures, including one mixed-case `"GetHearth.vercel.app"` at line 81 | `host: "oaktend.com"` / `origin: "https://oaktend.com"` (and the mixed-case variant becomes `"OakTend.com"` or similar, still exercising the case-insensitive path) |
| `src/lib/redteam0827.test.ts` | 14 | `const ORIGIN = "https://gethearth.vercel.app";` | `const ORIGIN = "https://oaktend.com";` |
| `src/lib/roleRouting.test.ts` | 567 | `const ORIGIN = "https://gethearth.vercel.app";` | `const ORIGIN = "https://oaktend.com";` |
| `src/components/HeroDemoPlayer.test.tsx` | 15 | a comment referencing `gethearth.vercel.app` (not a live string) | update the comment to `oaktend.com` |

These are all test-only fixtures exercising origin-matching and CSRF logic; the logic itself does
not care what the literal domain string is, so updating them is purely cosmetic/hygiene, not a
functional fix. They can be swapped any time in step 4, including in one bulk find-and-replace
commit.

### `hearth.build` (stale, was never the live domain; unrelated to this cutover but worth fixing in the same pass)

| File | Line | Current | Target |
|---|---|---|---|
| `src/app/api/address-suggest/route.ts` | 200 | `"User-Agent": "OakTend/1.0 (+https://hearth.build)"` | `"User-Agent": "OakTend/1.0 (+https://oaktend.com)"` |
| `src/lib/addressVerify.ts` | 115 | `"User-Agent": "OakTend/1.0 (+https://hearth.build)"` | `"User-Agent": "OakTend/1.0 (+https://oaktend.com)"` |

These are outbound HTTP User-Agent strings sent to third-party address-verification APIs. They
already say "OakTend" but point at a domain (`hearth.build`) the project never owned, so this was
wrong before the cutover too; fix it in the same commit since it is a one-line, low-risk change
in files already being reviewed for the domain swap.

### Root-level handoff/status docs (informational only, not app code; update at your discretion)

`STATUS.md` line 4, `handoff.md` line 170, and `HANDOFF-2026-09-03.md` lines 36 and 116 all
mention `gethearth.vercel.app`. These are timestamped working notes rather than live application
code or user-facing text, so they do not need to be part of the fourth commit; update them only
if it is useful to keep the running handoff log accurate, and note in `STATUS.md`'s next update
that the live site moved to `oaktend.com`.

### Already correct, no action needed

- `public/sw.js`: already says `"oaktend-sw-2"` and `title: "OakTend"` (service worker file,
  reviewed for this checklist, not domain-bound).
- `src/app/manifest.ts`: already says `name: "OakTend"` / `short_name: "OakTend"`, no hardcoded
  domain.
- `src/app/.well-known/security.txt/route.ts`: reads `LEGAL.securityEmail` and `LEGAL.siteUrl`
  from `src/lib/legal.ts`, both already dynamic on `NEXT_PUBLIC_SITE_URL`.
- `.env.local.example`: `RESEND_FROM` and `VAPID_SUBJECT` are already documented as
  `yourdomain.com` placeholders, not hardcoded to the old domain.
- No `.well-known/apple-developer-domain-association.txt` route was found in the repo; that file
  is uploaded manually per the Apple dashboard flow in `docs/APPLE-SIGN-IN-SETUP.md`, not
  generated by the app, so it needs no code change (but does need the manual re-verification in
  step 3).
