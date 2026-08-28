-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0137 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: two nullable timestamptz columns on public.users that remember
-- whether an account has already been shown the first-run app guide - one
-- stamp for the homeowner guide, one for the contractor guide, because one
-- account can hold both sides. No new table, no new policy, no new grant: the
-- "users self select" / "users self update" policies from migration 0002
-- already cover a user reading and writing their own row, which is all this
-- needs.
--
-- ORDER: this does not depend on 0134-0136. If those are still unapplied, this
-- can go in before or after them without changing anything.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/components/AppGuideMount.tsx reads the
-- stamp through a select *, so a database without these columns simply reports
-- "not seen yet", and the browser-side localStorage mirror in
-- src/components/AppGuide.tsx keeps the guide to once per browser in the
-- meantime. The write in src/lib/appGuideActions.ts errors and is swallowed on
-- purpose. Nothing 500s either way.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0137_app_guide_seen.sql >>>>>>>>>>

alter table public.users
  add column if not exists guide_seen_at timestamptz;

alter table public.users
  add column if not exists pro_guide_seen_at timestamptz;

comment on column public.users.guide_seen_at is
  'When this account closed the homeowner first-run app guide (src/components/AppGuide.tsx). Null = never shown yet. Stamped once, never cleared by the app.';
comment on column public.users.pro_guide_seen_at is
  'When this account closed the contractor first-run app guide. Separate from guide_seen_at because one account can hold both sides.';

-- <<<<<<<<<< END 0137_app_guide_seen.sql <<<<<<<<<<

-- ============================================================================
-- VERIFY (run these after the block above; each should match the note)
-- ============================================================================

-- 1. Both columns exist, both nullable, both timestamptz.
--    Expect exactly 2 rows: guide_seen_at | timestamp with time zone | YES
--                           pro_guide_seen_at | timestamp with time zone | YES
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'users'
--    and column_name in ('guide_seen_at', 'pro_guide_seen_at')
--  order by column_name;

-- 2. No account was accidentally stamped by the migration itself: every
--    existing row must still be null on both, so nobody silently loses a guide
--    they never saw. Expect one row: 0 | 0.
-- select count(*) filter (where guide_seen_at is not null)     as homeowner_stamped,
--        count(*) filter (where pro_guide_seen_at is not null) as pro_stamped
--   from public.users;

-- 3. RLS is still on for the table and no new policy appeared. Expect
--    users | true, and the same policy list as before (users self select,
--    users self update, plus whatever else is already there).
-- select relname, relrowsecurity from pg_class where relname = 'users';
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'users'
--  order by policyname;

-- 4. After signing in once on the live site and closing the guide, the stamp
--    should be set for that account and only that account. Replace the email.
-- select email, guide_seen_at, pro_guide_seen_at
--   from public.users
--  where email = 'you@example.com';

-- 5. If you ever want to see the guide again yourself for a screenshot, clear
--    your own stamp AND clear the browser mirror (devtools > Application >
--    Local Storage > remove hearth_app_guide_seen / hearth_pro_guide_seen).
--    Both have to go: either one alone keeps the guide hidden.
-- update public.users
--    set guide_seen_at = null, pro_guide_seen_at = null
--  where email = 'you@example.com';
