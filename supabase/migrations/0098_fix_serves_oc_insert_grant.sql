-- =============================================================================
-- Hearth - let new pros actually record their Orange County confirmation (0096)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- BUG (found 2026-07-19 while debugging a blocked contractor signup):
-- 0074 added contractors.serves_orange_county, default FALSE, as a HARD gate:
-- open_jobs_for_me() and the apply path show a pro nothing until it is true.
-- The onboarding form asks the question, and saveCompanyAction's UPDATE path
-- can write it (0083 grants UPDATE on the column), but two things broke the
-- CREATE path:
--   1. 0083's column-scoped INSERT grant list omits serves_orange_county, so
--      any creating insert that carries it fails 42501 (empirically confirmed
--      against the live DB with a throwaway account).
--   2. The code's creating insert consequently leaves the field out entirely,
--      so the pro's "Yes, I serve Orange County" answer was silently dropped
--      and the row kept the FALSE default.
-- Net effect: every pro created via onboarding since 0083 sees an empty job
-- board, full stop, and the profile form does not render the field, so there
-- was no way to self-correct.
--
-- FIX, two parts:
--   1. Add serves_orange_county to the INSERT column grant (additive; the
--      UPDATE grant already includes it). The companion code change makes the
--      creating insert carry the field again.
--   2. Backfill existing rows to TRUE. Justified, not a blanket guess: since
--      0074, answering "No" waitlists the signup BEFORE any contractors row
--      is created, so every row created through onboarding after that
--      necessarily answered "Yes" and had the answer dropped by bug 2. Rows
--      predating 0074 are cold-start test accounts at current scale. If a
--      real legacy pro should be opted out, flip their row manually.
--
-- Idempotent: grants are additive/no-op on re-run; the backfill only touches
-- rows still false. Safe to re-run.
-- =============================================================================

grant insert (serves_orange_county) on public.contractors to authenticated;

update public.contractors
   set serves_orange_county = true
 where serves_orange_county = false;
