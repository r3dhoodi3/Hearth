-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0133 (2026-08-27)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0132 before this. After running, live is at 0133.
--
-- WHAT THIS IS: one new table, app_feedback, backing the in-app review
-- prompt ("Enjoying Hearth?" -> Love it / Not really) and the private
-- /feedback form "Not really" routes to. See the migration file itself
-- (supabase/migrations/0133_app_feedback.sql) for the full reasoning.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/components/ReviewPrompt.tsx and
-- src/app/(app)/feedback/actions.ts both talk to this table; until it exists
-- the eligibility check and every insert simply error, which the actions file
-- treats as "not eligible" / "couldn't save" rather than throwing, so no page
-- goes down waiting on it - the prompt just never appears and the feedback
-- form shows its normal error toast.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0133_app_feedback.sql >>>>>>>>>>

create table if not exists public.app_feedback (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  side          text not null default 'homeowner' check (side in ('homeowner', 'pro')),
  kind          text not null check (kind in ('prompt_shown', 'loved', 'not_really')),
  message       text,
  contact_email text,
  created_at    timestamptz not null default now()
);
create index if not exists app_feedback_user_id_idx on public.app_feedback (user_id);

-- At most one message-less prompt event ('prompt_shown'/'loved'/'not_really')
-- per account, so the "ask at most once" rule is enforced by the database and
-- not by the app winning a read-then-write race. The /feedback form's rows
-- carry a message and are exempt, so somebody can still send more than one
-- note. See the migration file for the full reasoning.
create unique index if not exists app_feedback_one_event_per_kind_idx
  on public.app_feedback (user_id, kind)
  where message is null;

alter table public.app_feedback enable row level security;

drop policy if exists "app_feedback self insert" on public.app_feedback;
create policy "app_feedback self insert" on public.app_feedback
  for insert to authenticated
  with check (user_id = auth.uid());

comment on table public.app_feedback is
  'Review-prompt event log ("prompt_shown"/"loved"/"not_really") and the private feedback form it routes an unhappy answer to. Insert-your-own-row only for authenticated: no select policy exists, so nobody can read a row back, including their own. The service role reads everything.';

-- <<<<<<<<<< END 0133_app_feedback.sql <<<<<<<<<<

-- Verify (should return one row: app_feedback | YES):
--   select relname, relrowsecurity
--     from pg_class
--    where relname = 'app_feedback';
--
-- Verify RLS: an authenticated user can insert their own row but a select
-- from the browser's own session (anon/authenticated key) returns nothing,
-- ever - that is the design, not a bug. Only the service-role key (used by
-- src/app/(app)/feedback/actions.ts via createAdminClient()) can read it:
--   select kind, count(*) from public.app_feedback group by kind;
