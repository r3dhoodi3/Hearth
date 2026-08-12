-- =============================================================================
-- Hearth - priority support flag
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Set for messages sent by active Pro members so the team triages them first.
-- Written by the app at insert time (the /pro/help server action checks the
-- membership server-side); it is never user-supplied. No RLS changes needed:
-- the existing "support self insert" / "support self select" policies already
-- cover the row, and staff read everything through the service role.
--
-- Safe to re-run.
-- =============================================================================

alter table public.support_messages
  add column if not exists priority boolean not null default false;
