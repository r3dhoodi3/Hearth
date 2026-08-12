-- =============================================================================
-- Hearth - household QR scan grace window (0097)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- 0095_household_qr_invites.sql (already applied live - do not edit it) is
-- unchanged in behavior except for one app-side constant: the household tab
-- now mints tokens with a 5 minute TTL instead of 10
-- (QR_TOKEN_LIFETIME_SECONDS in src/app/(app)/account/household/actions.ts).
-- That alone is not a schema change, so it needed no migration. This one is.
--
-- PROBLEM: a 5 minute code is short enough that a signed-out scanner who
-- still has to create an account and get through onboarding can easily run
-- past expires_at before they ever reach the redeem step - even though they
-- scanned well within the live window and did nothing wrong.
--
-- FIX: household_invite_tokens gains scanned_at. The join page
-- (src/app/join/household/[token]/page.tsx) stamps it the FIRST time the
-- link is opened while still valid, and in the same update extends
-- expires_at to a flat 30 minutes from that moment - enough room for a real
-- signup + onboarding, not indefinite. The stamp happens unconditionally on
-- page load, before the signed-in/signed-out branch, so a signed-out scanner
-- (the exact case this fixes) starts their window immediately, not only
-- after they finish creating an account.
--
-- The extension is a single conditional UPDATE, done via the admin
-- (service-role) client since this table has no client-facing RLS policy at
-- all (see 0095's header):
--
--   update household_invite_tokens
--      set scanned_at = now(), expires_at = now() + interval '30 minutes'
--    where token = $1
--      and scanned_at is null
--      and expires_at > now();
--
-- scanned_at is null and expires_at > now() are BOTH required in the same
-- statement, so:
--   - a repeat open of the same link (scanned_at already set) matches zero
--     rows and can never re-extend or re-arm the grace window, and
--   - a link opened after it already expired (expires_at <= now()) also
--     matches zero rows, so an expired code can never be revived by opening
--     it - it just falls through to the honest expired-code state, same as
--     today.
--
-- redeem_household_invite_token() (0095) needs no change: it already
-- checks expires_at > now() at redemption time and does not care whether
-- that expiry is the original 5-minute one or the extended 30-minute one.
--
-- NET THREAT MODEL: a leaked or screenshotted code that nobody has opened
-- yet goes dead in 5 minutes, same as before. A code that WAS opened within
-- that window buys the person who opened it exactly one 30 minute setup
-- window to finish signing up and land back on the join page - never
-- renewable, since the scanned_at guard means that 30 minute window cannot
-- be extended again by opening the link a second time.
--
-- MINT CLEANUP: mintHouseholdQrTokenAction's self-cleanup delete (0095) also
-- changed app-side to spare a scanned, still-live token: it now deletes only
-- rows where scanned_at is null OR expires_at <= now(), instead of
-- unconditionally deleting all of this owner's tokens for the property on
-- every re-mint. Without that change, the tab's own 5-minute auto re-mint
-- would delete a scanned token out from under someone mid-signup. No schema
-- change needed for that half of the fix, it is app code only.
--
-- Idempotent: add column if not exists. Safe to re-run.
-- =============================================================================

alter table public.household_invite_tokens
  add column if not exists scanned_at timestamptz;

comment on column public.household_invite_tokens.scanned_at is
  'Set once, the first time /join/household/[token] is opened while the '
  'token is still valid. That same update extends expires_at to 30 minutes '
  'from this moment, giving a real signup + onboarding flow enough room. '
  'Null means never opened (or opened only after it had already expired, '
  'which does not count). Never re-set once non-null, so the 30 minute '
  'grace window is granted exactly once per token.';
