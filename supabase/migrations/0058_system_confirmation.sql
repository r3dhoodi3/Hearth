-- =============================================================================
-- Hearth - walk-your-home system confirmation (0056)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Every home_systems row today is either hand-entered or auto-seeded at
-- onboarding with an ESTIMATED install_year (guessed from the property's
-- build year, see src/app/onboarding/actions.ts). Nothing on the row says
-- which is which, so the app can never tell an owner-verified system apart
-- from a guess.
--
-- confirmed_at: set the moment an owner walks the home, snaps a system's data
-- plate, and confirms the (editable) suggestion Hearth read off it - see
-- /walkthrough and confirmSystemAction (src/app/(app)/walkthrough/actions.ts).
-- Null means the row is still an estimate. No backfill: every existing row
-- starts null, which is correct - none of them have been confirmed yet.
--
-- No RLS changes: home_systems already has "home_systems owner all" (0002,
-- gated by owns_property()), which covers this new column with no changes.
--
-- Safe to re-run.
-- =============================================================================

alter table public.home_systems
  add column if not exists confirmed_at timestamptz;

comment on column public.home_systems.confirmed_at is
  'Set when the owner confirms this system''s details via the walkthrough scan flow (never on insert/estimate). Null means the row is still an estimate.';
