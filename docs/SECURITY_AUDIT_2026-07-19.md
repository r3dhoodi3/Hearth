# OakTend Security Audit — 2026-07-19

Consolidated findings from an 8-agent red-team pass + a manual ("Fable") deep-verification
pass. READ-ONLY audit; **no code was changed and nothing was committed.** Branch
`fix/money-safety-0058`, working tree still has the large uncommitted change set.

Severity legend: CRITICAL / HIGH = fix before launch. MED = fix soon. LOW = hardening.
"CONFIRMED" = traced in code/SQL. "SUSPECTED" = strong code-path evidence, not executed.

> **Root-cause caveat that colors everything below:** migrations are hand-applied to the
> live Supabase project with no `schema_migrations` bookkeeping, duplicate numbering
> (0019/0020/0021), and the live DB is believed to lag the repo. Several fixes below are
> "only real if the migration was actually pasted." **Top operational action: baseline the
> migrations and verify 0067–0081 are actually live** (see `supabase/MIGRATIONS.md`).

---

## CRITICAL / HIGH — launch blockers

### 1. Migration 0078 column-REVOKE is a NO-OP → live trust-badge & balance self-forgery (IDOR)
- **CONFIRMED (manually verified).** In Supabase, `authenticated` holds the *table-level*
  UPDATE/INSERT on `public.contractors` by default (`ALTER DEFAULT PRIVILEGES … GRANT ALL`).
  0067 revoked only `SELECT`; no migration ever revokes table-level UPDATE/INSERT. Postgres
  ignores column-level REVOKEs while the table-level grant stands, so
  `0078_lock_contractor_columns.sql:92-123` changes nothing. Applying 0078 as written does
  **not** close the hole.
- **Exploit (today, from the browser console with only the anon key + own session):**
  ```js
  supabase.from('contractors').update({
    license_verified_status:'verified', background_check_status:'clear',
    background_checked_at:new Date().toISOString(), balance:999999
  }).eq('id', myContractorId)
  ```
  Self-grants the "License verified" / "Background checked" badges shown to homeowners on
  `/p/<id>`, and writes `balance`.
- **Also self-inflatable, same class:** `contractors.rating` / `review_count` (never locked).
- **Correct fix (delicate — this is why it needs a careful hand):**
  ```sql
  revoke update, insert on public.contractors from authenticated, anon;
  grant update (<editable cols>) on public.contractors to authenticated;
  grant insert (<editable cols>) on public.contractors to authenticated;
  ```
  `<editable cols>` must exactly match what legit user-scoped writes touch (profile save
  `pro/actions.ts:201-204`, onboarding insert `:340/:348`, license_number edit `:466`,
  compliance expiry `api/pro-compliance:246`): name, license_number, service_area,
  contact_phone, contact_email, categories, service_state, serves_orange_county, slug,
  logo_url, about, license_expires, insurance_carrier/insurance_expires + doc paths (insert
  also: id, user_id, vetted, referred_by, referred_attributed_at). **Exclude** the trust
  columns AND `rating`/`review_count` (trigger-maintained) — that closes both holes. Trust
  writes already go through the admin client, so nothing legit breaks. A wrong grant list
  yields `permission denied` (42501), which the code's missing-column retry does NOT catch,
  so verify against staging.

### 2. No Stripe dispute / refund / chargeback handling → deposit-then-chargeback double-spend
- **CONFIRMED.** `api/stripe/webhook/route.ts` handles no `charge.refunded`,
  `charge.dispute.*`, or `invoice.payment_failed`; no `stripe.refunds.create` anywhere.
- **Exploit:** pro deposits $1,000 (wallet credits cash + bonus), spends it unlocking leads,
  then files a card chargeback. Stripe pulls the money back; wallet is untouched; leads stay
  unlocked. Same shape for membership credit. Unbounded, attacker-initiated, repeatable.
- **Fix:** handle `charge.dispute.created` / `charge.refunded` (signature-verified) with an
  idempotent reversal RPC that debits cash/bonus (clamp at 0, ledger row), revoke entitlement
  on subscription refunds, freeze/negative-guard the wallet on open disputes. Add a deposit
  maximum (currently only a $5 min, no cap).

### 3. Job-post → pro email fan-out "cannon" (cost + reputation)
- **CONFIRMED.** `COLD_START_FREE_POSTING`/`COLD_START_FREE_ALERTS` are currently `true`
  (`constants.ts:86-87`), which skips the "3 open jobs" cap. Ownership is a hardcoded
  `ownership_verified:true` with no proof (`onboarding/actions.ts:190`). Only throttle is
  `rate_limit_hit('post:<user>',8,3600)` = 8/hr, no daily cap. Each post fans out up to 200
  emails via `sendEmail`, which (unlike SMS) has **no consent gate**.
- **Impact:** up to ~38k Resend emails/day per account, DB row bloat, and sender-domain
  reputation damage that would break real transactional email site-wide.
- **Fix:** per-user daily cap + email dedup per (contractor,category) + stronger ownership
  check; consider flipping the COLD_START flags off.

### 4. Sybil referral self-dealing loop (~$50/cycle at ~$0 real cost)
- **CONFIRMED (code reading).** `choose_applicant` is free and does not require the chosen
  applicant be a stranger; `grant_referral_rewards` (0044) pays $25 + $25 the instant an app
  hits `status='chosen'`. One reusable homeowner account + rotating contractor pairs farms
  $50 bonus/cycle. Bonus isn't cash-withdrawable but is 1:1 spendable on real lead fees (the
  actual product). Winback ($15) and first-apply guarantee fund the apply fee, so cash outlay
  ≈ $0.
- **Fix:** in `grant_referral_rewards`, reject when the referred pro's `user_id` == the job
  chooser's `user_id`; require ≥1 other applicant or a minimum job age before rewarding.

### 5. Migration 0077 trigger breaks account deletion (CCPA erase) — BROKEN-LEGIT
- **CONFIRMED.** `contractor_leads.contractor_id` FK is `ON DELETE SET NULL`, implemented as
  an UPDATE, which fires `enforce_contractor_leads_locked()` (0077). With no
  `oaktend.lead_write` flag set (admin client is service_role, not exempt), the trigger reverts
  the null, the FK still points at the row being deleted, and the delete fails → deletion
  aborts permanently for any pro who ever had an assigned lead.
- **Fix:** skip the revert when `pg_trigger_depth() > 1` (RI-initiated), or route the
  contractors delete through a SECURITY DEFINER RPC that sets the flag. Dry-run on staging.

### 6. RentCast (paid API) burn
- **CONFIRMED.** `lookupParcelAction` gated only by `rate_limit_hit('parcel:<user>',10,3600)`
  = 10/hr forever; cache key is exact street text (trivially evaded). ~2 billed calls/lookup
  → ~480/day/account vs a 50/month free tier.
- **Fix:** per-user + global daily/monthly ceiling; normalize/fuzz the cache key.

### 7. Unbounded storage uploads + client-trusted MIME (SVG)
- **CONFIRMED (count) / SUSPECTED (0079 live?).** Uploads go browser→Storage with the user's
  session; no rate/count/byte limit anywhere. Size/MIME limits live only in
  `0079_storage_mime_limits.sql` (a pending migration) and client JS. An SVG with `<script>`
  passes the client `startsWith('image/')` check and can land in the **public** `pro-logos`
  bucket (executes on the `*.supabase.co` origin — phishing-grade, not first-party session).
- **Fix:** apply 0079; add an upload rate/byte limiter; real server-side content sniffing
  (not client `file.type`).

### 8. Winback + first-apply guarantee sybil-farmable across accounts
- **CONFIRMED (0075 says so explicitly).** Per-user guards only; no identity dedup. $15
  winback per throwaway account; first-apply guarantee never got even the 0075-style guard.
  Both fund finding #4.
- **Fix:** promote 0075's deferred identity clustering to an automated throttle; add
  `claim_promo(...,'first_apply_guarantee',...)` to `guarantee_refund_first_application`.

### 9. Unbounded lead-chat flood + unbounded history reads
- **CONFIRMED.** `LeadChat.tsx:412` inserts to `messages` client-side, no rate limit, no body
  length CHECK; every counterparty load + 15s poll re-fetches the ENTIRE lead history (no
  `.limit()`), as do the chats-list / CRM pages.
- **Fix:** `rate_limit_hit` before the insert (or move to a server action), body-length
  CHECK, `.limit()` / `distinct on` on the read queries.

### 10. AI + promo features fail CLOSED if code ships before migrations 0070/0071 — DEPLOY-ORDER
- **CONFIRMED.** `aiUsage.ts` fails closed without `bump_ai_usage` (0070) → all AI routes go
  dark; `hasClaimedPromo` fails closed without 0071. Given the live-DB lag, deploying app code
  first bricks Ask OakTend, quote analyzer, etc.
- **Fix:** apply the 0067–0081 bundle before/with the deploy; gate the deploy on it.

---

## MEDIUM

- **`contractor_leads.status` arbitrary transitions** (availability): either party can PATCH
  status out of sequence (enum-only, not transition-guarded), bypassing "no cancel after
  apply" + confusing crons. Fix: transition-guard trigger.
- **`recordTermsAcceptance` spam/forgery window**: re-verifies session but falls back to a
  client-supplied UUID in the pre-cookie signup window, unauthenticated, unrate-limited →
  consent-log spam/forgery. Fix: verify JWT or rate-limit + narrow the fallback.
- **OC launch gate not enforced in `apply_to_lead`**: RPC checks only category, not
  `serves_orange_county`/`service_state`; any pro can enumerate lead UUIDs from the anon
  `lead_previews` and apply. Fix: re-check locality inside the RPC.
- **Collusion reviews** slip past the self-review guard (0080 only blocks same auth.uid) —
  needs identity dedup.
- **`market_waitlist` open anon insert** (`with check(true)`, no rate limit) → spam/poison.
  Fix: server action + throttle.
- **Homeowner waitlist insert always fails NOT NULL** (`onboarding/actions.ts:126` omits
  required `email`) while telling the user "you're added." Fix: pass the session email.
- **`support_messages` / `reports` rate-limit bypass**: limiter is in the server action only;
  raw PostgREST insert skips it. Fix: move the limiter into a BEFORE INSERT trigger / RPC.
- **Public OG-image route** (`p/[id]/opengraph-image.tsx`) interpolates an uncapped business
  name into `ImageResponse` with no try/catch → crafted name 500s the public card. Fix: cap
  length + try/catch fallback.
- **`messages.sender_role` spoofing** (in-thread role impersonation, pollutes dispute record)
  and **`lead_reads` role forgery** (read-receipt manipulation): derive role server-side.

---

## Clean bills (verified, no action needed)

- **Secrets / PII exposure: CLEAN.** No secret reaches the client bundle (admin/stripe/checkr/
  notify/parcel are server-only; only `NEXT_PUBLIC_` = url/anon-key/site-url/publishable-key).
  No hardcoded creds. Public routes (`/p/[id]`, pro-widget, share cards, opengraph) leak only
  intended-public data. `next.config` ships good headers, no prod source maps.
- **XSS: none found.** React auto-escaping; hand-rolled markdown renderer emits no HTML from
  AI/user content; only `dangerouslySetInnerHTML` uses are escaped JSON-LD + static content.
  AI action blocks never auto-execute (button onClick only) and are enum-coerced.
- **SSRF (`logo_url`) fixed** (origin-pinned at both write and read, defense-in-depth).
- **Open redirect** guarded everywhere via `safeNext`. **SQL/RPC injection**: the one raw
  `.or()` is regex-guarded.
- **Realtime channels** are RLS-scoped — no cross-user leak (open jobs have
  `contractor_id=NULL`, denied by both side policies).
- **Wallets / wallet_transactions / bonus_grants / reviews / lead_applications / wallet_config
  / deposit_tiers / notifications**: default-deny; all mutations via SECURITY DEFINER RPCs
  granted to service_role only. Quotes/invoices/household column-locks are done CORRECTLY
  (table-level revoke then column grant) — only 0078 got it wrong.
- **Auth/session**: password reset + email change + account deletion require reauth; deletion
  order avoids orphans; Stripe/Checkr/Twilio webhooks verify signatures + idempotency; crons
  are `CRON_SECRET`-gated and fail-closed. Role metadata is self-assignable but is NOT an
  authz gate (every boundary re-resolves a real `contractors` row from a verified session).
- **Latent (not exploitable today):** `lib/auth.ts` uses unverified `getSession()` — safe
  only because middleware gates the routes; one future public route could break the invariant.
  Consider switching to `getUser()`/`getClaims()` or a CI lint. `charge_lead` has a lock-order
  inversion but is dead code (no caller).

---

## Suggested fix order (when the fix session happens)
1. Rewrite 0078 correctly (finding #1) + lock rating/review_count. **Highest value, delicate.**
2. Stripe dispute/chargeback handler + deposit cap (#2).
3. Job-post fan-out cap + email consent/dedup (#3); RentCast + storage limits (#6, #7).
4. Referral/winback/first-apply sybil guards (#4, #8).
5. Fix the 0077 deletion-breaking trigger (#5) BEFORE applying 0077 to live.
6. Baseline migrations + confirm 0067–0081 live; deploy-order gate (#10).
7. MED items.
