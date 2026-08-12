-- =============================================================================
-- Hearth - lock trust-badge columns on contractors (0078)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- IDOR (CRITICAL). "contractors update own" (0005_contractor_side.sql:33-36)
-- is a ROW-level policy only:
--   using (user_id = auth.uid()) with check (user_id = auth.uid())
-- It does not restrict which COLUMNS a contractor may write on their own row.
-- 0067_contractors_rls_hardening.sql already stripped column-level SELECT
-- down to a safe public list, but never did the same for UPDATE. So today,
-- any signed-in pro can call (from the browser, with nothing more than the
-- anon key + their own session):
--
--   supabase.from('contractors').update({
--     license_verified_status: 'verified',
--     background_check_status: 'clear',
--     background_checked_at: new Date().toISOString(),
--   }).eq('id', myContractorId)
--
-- and self-grant the "License verified" / background-check badges that
-- public_pro_profile() (0055/0057) shows to homeowners, or credit their own
-- contractors.balance. This migration revokes UPDATE on exactly those
-- columns from `authenticated`, so only a SECURITY DEFINER function or the
-- service-role (admin) client can write them going forward.
--
-- Column names verified against the migrations that added them:
--   license_verified_status, license_verified_at   -- 0037_license_verification.sql
--   license_verify_detail                            -- 0055_license_verification.sql (also re-sets license_verified_at)
--   background_check_status, background_checked_at,
--   checkr_candidate_id, background_check_detail      -- 0057_background_checks.sql
--   balance                                           -- 0008_wallet.sql
--
-- ⚠️ DEPLOYMENT-ORDER WARNING FOR THE HUMAN REVIEWER ⚠️
-- ---------------------------------------------------------------------------
-- Three LEGITIMATE app writes currently go through the user-scoped Supabase
-- client (createClient(), i.e. the `authenticated` role under RLS) rather
-- than the admin/service-role client, and WILL START FAILING the moment this
-- migration is applied, unless the application code below is switched to
-- createAdminClient() first (or these writes are moved behind a SECURITY
-- DEFINER RPC):
--
--   1. src/app/pro/actions.ts saveCompanyAction(), ~lines 193-196
--      (the `licenseWrite` object merged into the profile-save UPDATE) sets
--      license_verified_status / license_verified_at / license_verify_detail
--      to 'pending'/'unverified' + nulls whenever a pro changes their license
--      number, via `supabase.from("contractors").update(...)` where
--      `supabase = createClient()` (server.ts, user-scoped).
--
--   2. verifyContractorLicense() (src/app/pro/actions.ts:34-88), called from
--      saveCompanyAction (~line 231, ~line 343) AND verifyLicenseNowAction
--      (~line 438), writes the REAL CSLB result -
--      license_verified_status: 'verified'|'failed', license_verified_at,
--      license_verify_detail - onto the SAME user-scoped `supabase` client
--      it is passed in as a parameter. This is the single riskiest one: it's
--      how a pro's license badge is supposed to legitimately flip to
--      'verified' today, and it will silently no-op/error after this
--      migration ships.
--
--   3. startBackgroundCheckAction() (src/app/pro/actions.ts, ~lines 540-546)
--      writes checkr_candidate_id + background_check_status: 'invited' via
--      `const supabase = createClient();` (user-scoped) right after Checkr
--      accepts the candidate/invitation.
--
-- CONFIRMED ALREADY SAFE (no code change needed - these already use the
-- admin/service-role client, which bypasses table/column grants entirely
-- because it authenticates as service_role, not `authenticated`):
--   - src/app/api/checkr/webhook/route.ts: `createAdminClient()`, writes
--     background_check_status/_checked_at/_detail and checkr_candidate_id
--     lookups. Fine as-is.
--   - src/app/api/cron/license-recheck/route.ts: `createAdminClient()`,
--     writes license_verified_status/_at/_verify_detail on the weekly CSLB
--     recheck. Fine as-is.
--   - contractors.balance: only ever written inside SECURITY DEFINER
--     functions add_deposit()/unlock_lead() (0008_wallet.sql), which execute
--     as the function owner and so are unaffected by this REVOKE. (In
--     current app code neither RPC is actually called anymore - the wallet
--     system was superseded by wallets/wallet_transactions in
--     0058_money_safety.sql - so balance is effectively a dead column today;
--     locking it is pure defense-in-depth.)
--
-- RECOMMENDATION: land an app-code change swapping `createClient()` for
-- `createAdminClient()` at the three call sites above (the write only; keep
-- auth/ownership checks on the user-scoped client as they are) in the SAME
-- deploy as this migration, or apply this migration only after that change
-- is live. Do not apply this migration standalone against production without
-- one of those two.
--
-- Safe to re-run (REVOKE on a privilege that isn't currently granted is a
-- silent no-op in Postgres, never an error).
-- =============================================================================

revoke update (
  license_verified_status,
  license_verified_at,
  license_verify_detail,
  background_check_status,
  background_checked_at,
  checkr_candidate_id,
  background_check_detail,
  balance
) on public.contractors from authenticated;

-- The UPDATE revoke above blocks a self-forged badge on an EXISTING row, but
-- column-level grants apply separately to INSERT: without this, a pro's
-- FIRST-time onboarding insert (src/app/pro/actions.ts saveCompanyAction) can
-- still set license_verified_status: 'verified' or background_check_status:
-- 'clear' etc. on the brand-new row it's creating, since that INSERT goes
-- through the same user-scoped `supabase` (authenticated) client. Revoking
-- INSERT on the identical column list closes that gap; a new contractors row
-- must land with the column defaults (license_verified_status 'unverified',
-- background_check_status 'none', balance 0, the rest null) and have any
-- non-default value written afterward via createAdminClient(), scoped to the
-- new row's id.
revoke insert (
  license_verified_status,
  license_verified_at,
  license_verify_detail,
  background_check_status,
  background_checked_at,
  checkr_candidate_id,
  background_check_detail,
  balance
) on public.contractors from authenticated;
