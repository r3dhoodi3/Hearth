-- 0136: two indexes on public.household_members.
--
-- No new tables, columns, functions, policies or grants. Nothing about who can
-- read what changes here; these only give Postgres a cheaper way to answer two
-- lookups it already answers on every request.
--
-- WHY NOT `create index concurrently`. It cannot run inside a transaction
-- block, and both the Supabase SQL editor (for the PASTE-ME twin of this file)
-- and `supabase db push` wrap a migration in one. household_members is a small
-- table - a handful of rows per home - so a plain, briefly-locking CREATE INDEX
-- is measured in milliseconds here. If this table is ever large enough for the
-- write lock to matter, run the two statements one at a time outside a
-- transaction instead.

-- ---------------------------------------------------------------------------
-- 1. is_active_member(), the RLS function on the app's hottest reads.
-- ---------------------------------------------------------------------------
-- 0051 defines it as:
--
--   select exists (
--     select 1 from public.household_members hm
--     where hm.property_id = p_property_id
--       and hm.member_user_id = auth.uid()
--       and hm.status = 'active'
--   );
--
-- It backs the "properties member select" policy and, through owns_property()
-- (0124), the RLS on home_systems, maintenance_tasks, issues, photos,
-- contractor_leads and documents - i.e. it is consulted while evaluating every
-- one of the dashboard's parallel queries for a shared home.
--
-- The only index that existed on this table is
-- household_members_property_email_key, a unique index on
-- (property_id, lower(invited_email)). Its leading column matches, but
-- invited_email is not in this predicate at all, so beyond the property_id
-- prefix that index cannot help - Postgres still has to recheck every row on
-- the property for member_user_id and status. This index covers all three
-- columns of the predicate in the order they are filtered.
create index if not exists household_members_active_member_idx
  on public.household_members (property_id, member_user_id, status);

-- ---------------------------------------------------------------------------
-- 2. "which homes am I a member of", keyed by the member.
-- ---------------------------------------------------------------------------
-- The other direction, and it has no usable index at all today because
-- member_user_id is not the leading column of anything:
--
--   src/lib/notify.ts (lookupPlusStatus, the household-Plus leg):
--     .from("household_members").select("property_id")
--     .eq("member_user_id", userId).eq("status", "active")
--
--   src/lib/risk/facts.ts (householdPeerIds):
--     .eq("status", "active").or(member_user_id.eq.<id>, invited_by.eq.<id>)
--     - the member_user_id half of that OR.
--
-- Leading with member_user_id (the selective column) and carrying status
-- second matches both. invited_by, the other half of that OR, is deliberately
-- left unindexed: it is only read by the risk fan-out, which is off the
-- critical path and already limited to 200 rows.
create index if not exists household_members_member_status_idx
  on public.household_members (member_user_id, status);

comment on index public.household_members_active_member_idx is
  'Serves is_active_member(p_property_id) (0051), which RLS calls on every read of a shared home. Added in 0136.';

comment on index public.household_members_member_status_idx is
  'Serves the member-keyed lookups in lookupPlusStatus (notify.ts) and householdPeerIds (risk/facts.ts). Added in 0136.';
