# Domain cutover to oaktend.com: COMPLETE (2026-09-12)

Status: **done**. `https://oaktend.com` is the only domain the app serves on, and every vendor
that stores a URL points at it. This file is now a record of what was done plus the few things
that outlived the cutover. It is no longer a runbook, so there are no steps left to follow.

## What was done

- **Domain and DNS.** `oaktend.com` and `www.oaktend.com` were added to the Vercel project and
  pointed at Vercel from Cloudflare DNS (apex `A` record, `www` `CNAME`, both DNS only, proxy
  off). `oaktend.com` is the Primary Domain and holds a valid Vercel-issued certificate.
- **Old preview domains removed (2026-09-12).** The two `*.vercel.app` hostnames the project used
  to answer on were detached from the Vercel project. They no longer resolve to this app, and
  nothing in the codebase, the docs, or any vendor dashboard refers to them any more.
- **`oaktend.vercel.app` added as a redirect.** It was attached to the project and configured to
  `308` to `https://oaktend.com`, so the one remaining Vercel-hosted hostname forwards instead of
  serving a second copy of the site.
- **Site URL.** `NEXT_PUBLIC_SITE_URL=https://oaktend.com` (no trailing slash) is set on
  Production. That single variable drives canonical URLs, the sitemap, `robots.txt`, OG tags,
  `security.txt`, JSON-LD, and the default `legal@` / `support@` / `privacy@` / `security@`
  addresses through `src/lib/legal.ts`, so none of those are hardcoded anywhere.
- **Supabase.** Auth Site URL is `https://oaktend.com`, and the `oaktend.com` callback and
  confirm paths are on the Redirect URLs allow list.
- **Stripe.** The live webhook endpoint is `https://oaktend.com/api/stripe/webhook`, and
  `STRIPE_WEBHOOK_SECRET` in Vercel matches that endpoint's signing secret. The handler fails
  closed on a missing or wrong secret (`src/app/api/stripe/webhook/route.ts`), so a mismatch
  would have shown up as silently dropped webhooks, never as bad data.
- **Apple, Google, Resend.** Sign in with Apple's Services ID, the Google OAuth client's
  origins and redirect URIs, and Resend's verified sending domain and `RESEND_FROM` all use
  `oaktend.com`.
- **Code.** The brand rename sweep replaced every hardcoded old-domain string in app code and
  test fixtures, and fixed two outbound `User-Agent` headers that pointed at a domain the
  project never owned. They now send `OakTend/1.0 (+https://oaktend.com)`.

## Still open (owner, cosmetic only)

Neither of these affects a URL, an API key, a connection string, or anything a user can see.

- The **Vercel team slug is still `hearth-test`**. Renaming it changes only dashboard URLs.
- The **local checkout folder is still `C:\Users\lande\hearth`**. Renaming it is a local move;
  nothing in the repo depends on the folder name.

## Things worth keeping from the cutover

- **Do not proxy the DNS records.** Keep the `oaktend.com` records that point at Vercel on DNS
  only (grey cloud in Cloudflare). Turning Cloudflare proxying on in front of Vercel breaks
  Vercel's certificate issuance and hides the real client IP, which the app's IP-based rate
  limiting depends on.
- **PWA installs from the old origin.** Anyone who installed the app to their home screen from
  one of the retired `*.vercel.app` origins has a service worker registered against that origin.
  Those origins no longer resolve to this app, so the installed shell will not self-heal. The fix
  for anyone who reports it is to remove the old icon and reinstall from `oaktend.com`.
- **Web Push is per-origin.** Subscriptions created on an old origin do not carry over. The VAPID
  keypair itself did not need to change (it identifies the app server, not the origin), but each
  browser has to visit `oaktend.com` once with notification permission granted to record a new
  subscription. See `src/components/PushRegistrar.tsx` and `src/lib/push.ts`.
- **Legacy browser storage.** The cookies and localStorage keys carrying the old brand prefix
  were renamed to their `oaktend_*` equivalents in the brand rename sweep, with a read-side
  fallback to the old name so no signed-in user's value was dropped. That fallback lives in
  `src/lib/legacyStorage.ts`
  and `src/lib/legacyCookies.ts` and is scheduled for removal after 2026-12-31. Do not rename
  those keys again outside that mechanism.
- **`NEXT_PUBLIC_LEGAL_BRAND`** must stay unset or set to `OakTend`. `src/lib/legal.ts` falls back
  to `"OakTend"` when unset, so unset is fine; a stale explicit value would silently override the
  brand everywhere the legal copy renders.
