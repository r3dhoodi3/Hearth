-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0136 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent (create index IF NOT EXISTS).
--
-- WHAT THIS IS: two indexes on public.household_members, and nothing else.
-- No new tables, columns, functions, policies or grants. Nobody gains or loses
-- access to a single row; this only gives Postgres a cheaper way to answer two
-- lookups it already answers on every request.
--
-- NOTHING BREAKS IF YOU DELAY THIS. Every query below already works today; it
-- just does more work per call than it needs to. Applying this is a speed
-- change, not a correctness one.
--
-- WHY NOT `create index concurrently`. It cannot run inside a transaction
-- block, and the SQL editor wraps what you paste in one, so CONCURRENTLY here
-- would fail outright. household_members holds a handful of rows per home, so
-- the plain form below takes milliseconds and its brief write lock is not
-- something a live site will notice. (If this table ever grows large, run each
-- create index concurrently by itself, in its own editor tab, instead.)
-- ============================================================================

-- >>>>>>>>>> BEGIN 0136_household_members_idx.sql >>>>>>>>>>

-- 1. is_active_member(), the RLS function on the app's hottest reads.
--
-- 0051 defines it as: property_id = $1 AND member_user_id = auth.uid() AND
-- status = 'active'. It backs the "properties member select" policy and,
-- through owns_property() (0124), the RLS on home_systems, maintenance_tasks,
-- issues, photos, contractor_leads and documents - so it is consulted while
-- evaluating every one of the dashboard's parallel queries for a shared home.
--
-- The only index this table had is household_members_property_email_key, a
-- unique index on (property_id, lower(invited_email)). invited_email is not in
-- that predicate, so past the property_id prefix it cannot help.
create index if not exists household_members_active_member_idx
  on public.household_members (property_id, member_user_id, status);

-- 2. "which homes am I a member of", keyed by the member. No usable index
-- exists for this today, because member_user_id leads nothing:
--   src/lib/notify.ts   lookupPlusStatus: .eq(member_user_id).eq(status)
--   src/lib/risk/facts.ts householdPeerIds: the member_user_id half of its OR
create index if not exists household_members_member_status_idx
  on public.household_members (member_user_id, status);

comment on index public.household_members_active_member_idx is
  'Serves is_active_member(p_property_id) (0051), which RLS calls on every read of a shared home. Added in 0136.';

comment on index public.household_members_member_status_idx is
  'Serves the member-keyed lookups in lookupPlusStatus (notify.ts) and householdPeerIds (risk/facts.ts). Added in 0136.';

-- <<<<<<<<<< END 0136_household_members_idx.sql <<<<<<<<<<

-- Verify 1, both indexes exist (should return exactly two rows,
-- household_members_active_member_idx and household_members_member_status_idx,
-- with the column lists shown in their definitions):
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'household_members'
--      and indexname in ('household_members_active_member_idx',
--                        'household_members_member_status_idx')
--    order by indexname;
--
-- Verify 2, both are valid and ready (should return two rows, each with
-- indisvalid = true and indisready = true):
--   select c.relname as index_name, i.indisvalid, i.indisready
--     from pg_index i
--     join pg_class c on c.oid = i.indexrelid
--     join pg_class t on t.oid = i.indrelid
--    where t.relname = 'household_members'
--      and c.relname in ('household_members_active_member_idx',
--                        'household_members_member_status_idx');
--
-- Verify 3, the planner will actually use the first one. Substitute a real
-- property id and a real member's user id from your own data. On a table this
-- small Postgres may legitimately still choose a sequential scan (that is not
-- a failure - it means the table is too small for an index to pay); the point
-- is that the index is available and the plan is cheap either way:
--   explain analyze
--   select exists (
--     select 1 from public.household_members hm
--      where hm.property_id = '<a-property-id>'::uuid
--        and hm.member_user_id = '<a-member-user-id>'::uuid
--        and hm.status = 'active'
--   );
--
-- Verify 4, same for the member-keyed direction:
--   explain analyze
--   select property_id from public.household_members
--    where member_user_id = '<a-member-user-id>'::uuid
--      and status = 'active';
--
-- Verify 5, nothing else changed. Row count before and after must match, and
-- no policy or grant was touched by this file (should return the same number
-- you had before running it):
--   select count(*) from public.household_members;
