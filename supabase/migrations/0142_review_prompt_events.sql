-- =============================================================================
-- Hearth - review prompt: three more event kinds (0142)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY THIS EXISTS
-- The "Enjoying Hearth?" card used to end the conversation the moment somebody
-- tapped the App Store link: the tap was recorded as the answer, so a person
-- who bounced straight back without rating anything was never asked again, and
-- the app claimed a rating it had no way of knowing about. Apple never tells
-- an app whether a rating was left (SKStoreReviewController reports nothing,
-- and a plain store link reports even less), so the only truthful source is
-- the person themselves. That needs three more kinds:
--
--   rate_clicked   they tapped through to the store. An INTENT, not a rating.
--                  Nothing about the prompt is finished at this point.
--   rate_deferred  they came back, we asked "did you get a chance to rate
--                  Hearth?", and they said "Not yet". Back into the pool: the
--                  card can come round again in a later randomly-drawn
--                  session, and never again inside the same one.
--   rated          they said "Yes, done". THE permanent stop, on every device.
--
-- The other permanent stop is unchanged: 'not_really' sends somebody to the
-- private feedback form and they are never asked again. 'prompt_shown' and
-- 'loved' are now snoozes, not endings - see src/lib/reviewPrompt.ts.
--
-- NO REWARD MAY EVER BE ATTACHED TO ANY OF THESE ROWS. App Store Review
-- Guidelines 1.1.7 / 3.2.2 and Google Play's policy both forbid paying for
-- ratings, and the FTC treats an undisclosed incentivised review as deceptive.
-- There is a longer note in src/lib/reviewPrompt.ts.
--
-- WHAT IT CHANGES: only the CHECK constraint on app_feedback.kind (migration
-- 0133 pinned it to the original three). No new table, no new column, no
-- policy change. The existing unique index
-- app_feedback_one_event_per_kind_idx already covers the new kinds, since they
-- are all message-less: at most one of each per account, so a retried server
-- action collides (23505) instead of writing a second row.
--
-- Safe to re-run: the constraint is dropped by definition, not by name, then
-- re-added.
-- =============================================================================

do $migration$
declare
  r record;
begin
  if to_regclass('public.app_feedback') is null then
    raise exception
      'public.app_feedback is missing: run migration 0133 (or the ALL-PENDING bundle) before this one';
  end if;

  -- Dropped by DEFINITION rather than by name. Postgres names an inline column
  -- check app_feedback_kind_check, but a table created by hand, or re-created
  -- later, can carry a different name for the same rule, and adding the wider
  -- constraint while a narrower one survives would reject every new kind with
  -- no obvious cause.
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
