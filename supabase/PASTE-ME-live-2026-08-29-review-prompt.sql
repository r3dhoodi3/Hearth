-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0142 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- RUN THE app_feedback TABLE FIRST. This widens a constraint on
-- public.app_feedback, which arrives with migration 0133. If the live database
-- has not had 0133 yet (it is inside
-- supabase/PASTE-ME-ALL-PENDING-2026-08-29.sql), run that bundle first; this
-- one stops with a clear message rather than half-applying.
--
-- WHAT THIS IS: three more values allowed in app_feedback.kind, so the review
-- prompt can stop lying about what it knows.
--
--   rate_clicked   somebody tapped through to the App Store. An INTENT.
--   rate_deferred  they came back and answered "Not yet" when asked whether
--                  they got a chance to rate it.
--   rated          they answered "Yes, done". The permanent stop.
--
-- WHY: tapping the store link used to be recorded as the end of the prompt, so
-- anyone who went to the store and came back without rating was written off as
-- done. Apple never tells an app whether a rating was actually left, so the
-- app now asks the person when they return, and only their own "Yes, done"
-- ends it. See supabase/migrations/0142_review_prompt_events.sql and
-- src/lib/reviewPrompt.ts.
--
-- NOTHING BREAKS IF YOU DELAY THIS, but the new prompt loses its point: the
-- three new inserts fail the old CHECK constraint, recordReviewPromptEvent
-- swallows the error (it is best effort and logs to the server console), and
-- the browser still behaves correctly for the current session while forgetting
-- the answer on the next device. Nobody sees an error page.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0142_review_prompt_events.sql >>>>>>>>>>

do $migration$
declare
  r record;
begin
  if to_regclass('public.app_feedback') is null then
    raise exception
      'public.app_feedback is missing: run migration 0133 (or the ALL-PENDING bundle) before this one';
  end if;

  -- Dropped by definition rather than by name: the inline check from 0133 is
  -- called app_feedback_kind_check, but a table created by hand could carry
  -- the same rule under another name, and leaving a narrower one in place
  -- would reject every new kind with no obvious cause.
  for r in
    select con.conname
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'app_feedback'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%prompt_shown%'
  loop
    execute format('alter table public.app_feedback drop constraint %I', r.conname);
  end loop;

  execute $c$
    alter table public.app_feedback
      add constraint app_feedback_kind_check
      check (kind in (
        'prompt_shown',
        'loved',
        'not_really',
        'rate_clicked',
        'rate_deferred',
        'rated'
      ))
  $c$;
end
$migration$;

comment on table public.app_feedback is
  'Review-prompt event log ("prompt_shown"/"loved"/"not_really"/"rate_clicked"/"rate_deferred"/"rated") and the private feedback form an unhappy answer is routed to. Only "rated" and "not_really" stop the prompt for good; "rate_clicked" is a tap on the store link, never a rating. Insert-your-own-row only for authenticated: no select policy exists, so nobody can read a row back, including their own. The service role reads everything.';

-- <<<<<<<<<< END 0142_review_prompt_events.sql <<<<<<<<<<

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
-- 1. The constraint now lists all six kinds (one row, definition contains
--    'rated'):
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.app_feedback'::regclass
--      and contype = 'c'
--      and pg_get_constraintdef(oid) like '%prompt_shown%';
--
-- 2. Exactly one such constraint exists (should return 1, never 2):
--   select count(*)
--     from pg_constraint
--    where conrelid = 'public.app_feedback'::regclass
--      and contype = 'c'
--      and pg_get_constraintdef(oid) like '%prompt_shown%';
--
-- 3. The "at most one of each per account" index is still there and still
--    partial (should return app_feedback_one_event_per_kind_idx with
--    "WHERE (message IS NULL)"):
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'app_feedback';
--
-- 4. RLS is still on and there is still NO select policy (rowsecurity = true,
--    and the second query returns only the insert policy):
--   select relname, relrowsecurity
--     from pg_class where relname = 'app_feedback';
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.app_feedback'::regclass;
--
-- 5. Once the app has been used for a day, the event mix (service role only):
--   select kind, count(*) from public.app_feedback group by kind order by kind;
--    - rate_clicked much larger than rated is normal and honest: it counts
--      taps on the store link, not ratings.
