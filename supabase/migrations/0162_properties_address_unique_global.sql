-- =============================================================================
-- OakTend - lock a claimed address against a second owner (0162)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Tester feedback B8 (2026-09-07): once a homeowner claims their address,
-- nobody else should be able to claim the SAME address as its owner too.
-- Before this, two unrelated accounts could each end up with their own
-- properties row for one physical home, each one seeing themselves as the
-- owner - a second household simply invited to share the home is fine and
-- stays fine (that flow adds a household_members row against the EXISTING
-- property, never a second properties row), but a stranger creating a
-- competing "I own this too" row was never refused.
--
-- This is a DIFFERENT, narrower index than properties_owner_address_unique
-- (migration 0151): that one is scoped PER OWNER - (user_id, address, zip,
-- unit) - and only stops the SAME person double-claiming (a double-submit,
-- two open tabs). This index drops user_id from the key entirely, so it is
-- one home per (normalized street line, zip, unit) FULL STOP, across every
-- account. The app-level check-then-insert guard in
-- src/app/onboarding/actions.ts (claimPropertyAction, right above the
-- properties insert) is the primary guard and is what produces the plain
-- "This address is already registered..." message a homeowner actually
-- sees; this index is the database backstop against the same race
-- properties_owner_address_unique already guards for the per-owner case -
-- two truly concurrent claims of the one address from two different
-- accounts.
--
-- WHAT THIS DELIBERATELY REFUSES, so nobody is surprised by it later:
--   * A duplex, ADU, or granny flat where BOTH homes are entered with the
--     same street line and NO unit. The second one has to enter a unit
--     ("A"/"B"/"Rear"), which is what unit is in the key for. The refusal
--     copy in claimPropertyAction says so.
--   * A home that CHANGES HANDS. The previous owner's row keeps the address
--     forever, so a buyer cannot claim it themselves; they contact support
--     and a person moves the home. That is a deliberate trade (an address
--     lock is what the tester asked for) but it IS a manual path, and it
--     will happen in the real world - it needs an owner-facing transfer flow
--     before this product has any volume. Deleting the old account frees the
--     address automatically (properties cascades with the auth user).
--
-- Safe to re-run.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that isn't caught up -------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'properties'
  ) then
    raise exception 'PRECHECK: public.properties is missing. Apply migration 0001 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'properties' and column_name = 'unit'
  ) then
    raise exception 'PRECHECK: public.properties.unit is missing. Apply migration 0127 before this file. Nothing was changed.';
  end if;
end
$$;

-- Existing duplicate-address rows across DIFFERENT owners would make the
-- index build fail with a bare unique_violation. Check first and name them,
-- same courtesy 0151 gave the per-owner version of this index, so whoever
-- runs this gets a precise cleanup list instead of a cryptic Postgres error.
-- A duplicate here is not necessarily a bug to panic over - it may be two
-- accounts that should be merged into one household - but it does need a
-- human decision before this index can go on.
do $$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select 1
    from public.properties
    group by lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')),
             coalesce(zip, ''),
             lower(regexp_replace(btrim(coalesce(unit, '')), '\s+', ' ', 'g'))
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'B8: % duplicate (address, zip, unit) group(s) already exist in public.properties across different owners, so this index cannot be built. NOTHING WAS CHANGED. To see them, run: select lower(regexp_replace(btrim(address_line1), ''\s+'', '' '', ''g'')) as street, coalesce(zip,'''') as zip, lower(regexp_replace(btrim(coalesce(unit,'''')), ''\s+'', '' '', ''g'')) as unit, count(*) as rows, array_agg(user_id) as accounts, array_agg(id) as property_ids from public.properties group by 1,2,3 having count(*) > 1; Then, for each group, keep ONE row and either delete the throwaway/test rows or move the second person onto the kept home as a household_members row. supabase/FIX-DUPLICATE-HOMES-2026-08-30.sql does the same job for the SAME-OWNER case (0151) and is a good template, but it is scoped per user_id and will NOT clear these - do this pass by hand.',
      v_dupes;
  end if;
end
$$;

-- The key expressions mirror the app-level guard in claimPropertyAction
-- CHARACTER FOR CHARACTER: trim, collapse internal whitespace, lowercase.
-- The first cut of this index used a bare lower(btrim(...)) with no
-- whitespace collapse and a raw coalesce(unit, ''), which left two ways to
-- walk straight past the lock that the app-level check would have caught:
-- "123  Main St" (two spaces) and "APT 2" vs "Apt 2" each hashed to a
-- different key. Every expression here is IMMUTABLE, which is what an index
-- expression requires.
create unique index if not exists properties_address_unique
  on public.properties (
    lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')),
    coalesce(zip, ''),
    lower(regexp_replace(btrim(coalesce(unit, '')), '\s+', ' ', 'g'))
  );

comment on index public.properties_address_unique is
  'B8: one home per (normalized street line, zip, unit), across EVERY owner - '
  'not just per user like properties_owner_address_unique (0151). Backstop to '
  'the app-level address-lock guard in claimPropertyAction '
  '(src/app/onboarding/actions.ts) against two different accounts both '
  'claiming the same home as owner. Household invites are unaffected: they '
  'add a household_members row against the existing property, never a second '
  'properties row.';

-- ---- VERIFY -----------------------------------------------------------------
-- select indexname from pg_indexes
--   where schemaname = 'public' and tablename = 'properties'
--     and indexname = 'properties_address_unique';
-- -- expect one row.
--
-- -- Find any remaining duplicate-address groups the PRECHECK above would have
-- -- caught (should return zero rows once this file has applied cleanly):
-- select lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')) as street,
--        coalesce(zip,'') as zip,
--        lower(regexp_replace(btrim(coalesce(unit,'')), '\s+', ' ', 'g')) as unit,
--        count(*) as owners, array_agg(user_id) as accounts, array_agg(id) as property_ids
-- from public.properties
-- group by 1, 2, 3
-- having count(*) > 1;
