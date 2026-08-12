-- =============================================================================
-- Hearth - license verification status (0037)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Tracks how far a pro's license number has actually gotten through
-- verification, so the app can stop claiming checks it never ran:
--   unverified = no license number on file (or nothing queued yet)
--   pending    = license number on file, awaiting a check
--   verified   = confirmed by a license-registry API or manual review
--   failed     = a check ran and did not confirm the license
--
-- The app must NEVER claim verification it has not done. Until a row is
-- 'verified', homeowner-facing surfaces may only say the license is "on file".
-- saveCompanyAction stamps 'pending' when a pro supplies a license number;
-- moving to 'verified' or 'failed' is reserved for a registry integration or
-- manual review (neither exists yet).
--
-- No RLS changes: contractors' existing row policies already cover these
-- columns, and the public read path (public_pro_profile, 0033) still exposes
-- only the has_license boolean.
--
-- Safe to re-run.
-- =============================================================================

alter table public.contractors
  add column if not exists license_verified_status text not null default 'unverified'
    check (license_verified_status in ('unverified', 'pending', 'verified', 'failed')),
  add column if not exists license_verified_at timestamptz;

comment on column public.contractors.license_verified_status is
  'unverified = nothing to check; pending = license number on file awaiting a check; verified = confirmed by a license-registry API or manual review; failed = check did not confirm. The app must never claim verification it has not done.';
comment on column public.contractors.license_verified_at is
  'When the status last moved to verified (or failed). Null while unverified/pending.';
