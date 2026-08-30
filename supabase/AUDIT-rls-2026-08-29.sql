-- AUDIT ONLY, 2026-08-29. Least-privilege / "is anything public" review.
--
-- READ-ONLY. Every statement below is a SELECT. Nothing is created, altered,
-- dropped or granted, so it is safe to run on the live database at any time and
-- safe to run twice. That is the difference between this file and
-- supabase/PASTE-ME-live-audit-rls.sql, which audits AND then hard-resets the
-- policy set on public.properties: keep that one for the properties fix, run
-- this one whenever you want to know where things stand.
--
-- HOW TO RUN. Supabase dashboard -> SQL Editor -> New query -> paste this whole
-- file -> Run. The editor shows one result grid per statement; scroll through
-- them in order. Copy every non-empty grid back to Claude.
--
-- WHAT "GOOD" LOOKS LIKE. Sections 1, 2, 3, 4, 6, 7 and 9 should all come back
-- EMPTY. Sections 5, 8 and 10 always return rows; they are inventories to read,
-- not alarms.

-- ===========================================================================
-- 1. Tables in public with row level security switched OFF
-- ===========================================================================
-- Any row here is readable and writable by every signed-in user (and by anyone
-- at all if the table is also granted to anon, section 4). On 2026-08-20
-- public.properties turned up here after a dashboard click.
-- EXPECTED: zero rows.
select
  c.relname as table_name,
  'RLS IS OFF' as finding
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and not c.relrowsecurity
order by 1;

-- ===========================================================================
-- 2. Tables with RLS on but NO policies at all
-- ===========================================================================
-- Not a leak: with RLS on and no policy, normal roles read nothing. It is
-- listed because it is almost always a mistake in the other direction (a
-- feature that silently returns empty) and because it means a later "just add
-- one policy" click has no siblings to be consistent with.
-- EXPECTED: zero rows.
select
  c.relname as table_name,
  'RLS on, zero policies (denies everyone but service_role)' as finding
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies p
     where p.schemaname = 'public' and p.tablename = c.relname
  )
order by 1;

-- ===========================================================================
-- 3. Wide-open or anon-facing policies
-- ===========================================================================
-- A policy whose USING clause is literally `true` lets every row through for
-- whichever roles it names. That is correct for a genuinely public catalogue
-- and wrong for everything else, so read each row and decide. `{public}` in the
-- roles column means EVERY role including anon, not "the public schema".
-- This is the dashboard-template shape ("Enable read access for all users").
-- EXPECTED: zero rows. If a row is deliberate, write down why.
select
  tablename,
  policyname,
  roles,
  cmd,
  qual as using_clause,
  with_check
from pg_policies
where schemaname = 'public'
  and (
    qual = 'true'
    or with_check = 'true'
    or roles::text like '%anon%'
    or roles::text = '{public}'
  )
order by tablename, policyname;

-- ===========================================================================
-- 4. Table-level grants to anon or PUBLIC anywhere in public
-- ===========================================================================
-- RLS only filters rows for roles that hold the underlying grant. Revoking the
-- grant from anon is the belt to RLS's braces: with no grant, an unauthenticated
-- PostgREST request is refused before any policy is consulted.
-- EXPECTED: zero rows.
select
  grantee,
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'PUBLIC')
order by table_name, grantee, privilege_type;

-- ===========================================================================
-- 5. What `authenticated` may do, per table
-- ===========================================================================
-- An inventory, not an alarm. The thing to look for: a table where
-- authenticated holds UPDATE on rows it should only ever read (reviews it did
-- not write, another account's contractor row), or holds DELETE anywhere the
-- app never deletes. Column-level locks (migration 0139 locks columns on
-- public.users) do not show up here; section 6 covers those.
select
  table_name,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = 'authenticated'
group by table_name
order by table_name;

-- ===========================================================================
-- 6. Column-level grants to authenticated / anon
-- ===========================================================================
-- Where a table grants UPDATE on only some columns (the pattern migrations 0085
-- and 0139 use), this is the list of columns a user's own session can write
-- directly, without passing through any server action that validates them.
-- Read it as: "these strings are untrusted input, forever".
select
  grantee,
  table_name,
  column_name,
  privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('UPDATE', 'INSERT')
order by table_name, column_name, grantee;

-- ===========================================================================
-- 7. SECURITY DEFINER functions callable by anon or authenticated
-- ===========================================================================
-- A SECURITY DEFINER function runs as its owner and ignores RLS. Each one is a
-- deliberate hole punched through the policies, so each one has to justify
-- itself. Two things to check on every row:
--   1. Is `anon` in grantees? An anon-callable definer function is reachable by
--      anyone on the internet with the public anon key. Migration 0123 revoked
--      the public browse functions from anon for exactly this reason.
--   2. Is search_path pinned in the config column (`search_path=public, ...`)?
--      A definer function without a pinned search_path can be hijacked by a
--      caller-controlled schema.
-- EXPECTED: no `anon` rows, and no blank search_path.
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  case p.prosecdef when true then 'DEFINER' else 'invoker' end as security,
  coalesce(array_to_string(p.proconfig, ', '), '(no search_path pinned)') as config,
  array(
    select g.grantee_name
    from (
      select 'anon' as grantee_name where has_function_privilege('anon', p.oid, 'EXECUTE')
      union all
      select 'authenticated' where has_function_privilege('authenticated', p.oid, 'EXECUTE')
      union all
      select 'PUBLIC' where has_function_privilege('public', p.oid, 'EXECUTE')
    ) g
  ) as callable_by
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and (
    has_function_privilege('anon', p.oid, 'EXECUTE')
    or has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )
order by 1;

-- ===========================================================================
-- 8. Views in public: do they respect the caller's RLS?
-- ===========================================================================
-- THE QUIET ONE. A normal Postgres view runs with the privileges of the role
-- that OWNS it (usually postgres, which is exempt from RLS), so a view over a
-- protected table can hand out every row of that table even though the table's
-- own policies are perfect. Postgres 15 added `security_invoker`, which makes
-- the view run as the caller instead and re-applies RLS.
-- READ EVERY ROW. Any view where security_invoker is not 'on' AND that is
-- readable by anon or authenticated is a potential bypass of section 3.
select
  c.relname as view_name,
  coalesce(
    (select option_value from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'),
    'off (runs as the view owner, ignores RLS)'
  ) as security_invoker,
  pg_get_userbyid(c.relowner) as owner,
  has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('v', 'm')
order by 1;

-- ===========================================================================
-- 9. Storage buckets that are public
-- ===========================================================================
-- A public bucket serves every object in it over an unauthenticated URL. The
-- URL is not secret: object paths in this app contain user ids and row ids, so
-- "nobody knows the link" is not a control.
-- EXPECTED: only buckets whose entire contents are meant to be on the open web
-- (a pro's logo, which is already printed on their public /p/ page). Homeowner
-- photos, documents, insurance packets and inspection PDFs must be private and
-- reached through a signed URL or the /api/img proxy.
select
  id as bucket,
  public as is_public,
  file_size_limit,
  allowed_mime_types,
  created_at
from storage.buckets
order by public desc, id;

-- ===========================================================================
-- 10. Storage object policies, per bucket
-- ===========================================================================
-- For every PRIVATE bucket in section 9, this is the whole of what a signed-in
-- user may do to objects in it. Look for a policy that does not scope the
-- object name to the caller (the usual shape is
-- `(storage.foldername(name))[1] = auth.uid()::text`).
select
  policyname,
  roles,
  cmd,
  qual as using_clause,
  with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;

-- ===========================================================================
-- 11. Tables published to Supabase Realtime
-- ===========================================================================
-- Realtime re-checks RLS per subscriber ONLY for tables in this publication
-- when the subscription goes through the authorised channel. Every table listed
-- here is one whose row changes are streamed to browsers, so each one needs a
-- SELECT policy that is correct for a LIVE STREAM, not just for a page load.
-- Cross-check each table here against section 3.
select
  schemaname,
  tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by 1, 2;

-- ===========================================================================
-- 12. Roles that can log in, and what they are
-- ===========================================================================
-- Sanity check that nobody has added a custom superuser or a role with BYPASSRLS
-- through the dashboard. postgres, supabase_admin and the Supabase internal
-- roles are expected; anything else needs an explanation.
select
  rolname,
  rolsuper,
  rolbypassrls,
  rolcanlogin
from pg_roles
where rolcanlogin or rolsuper or rolbypassrls
order by rolsuper desc, rolbypassrls desc, rolname;
