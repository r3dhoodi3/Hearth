-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0147 (2026-08-30)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: one nullable bigint column on public.properties,
-- repair_reserve_cents, plus a range CHECK and two column-level grants.
--
-- WHY: the cost forecast can already tell an owner "set aside about $210 a
-- month". Until this column exists it cannot tell them "and you are $60 a month
-- short", because nothing stores what they have actually put away. That second
-- sentence is what turns the forecast from an estimate into a plan.
--
-- Null means "the owner has not told us", which the app treats differently from
-- zero: null shows an invitation, zero shows how far behind they are. Nothing
-- is backfilled, so every existing home starts as "has not told us", which is
-- the truth.
--
-- Cents as bigint, matching every other money column in this schema. Per
-- PROPERTY, not per user: two homes have two timelines and two reserves.
--
-- ORDER: apply after 0146. It touches no function, view or policy that any
-- other pending migration owns, so it does not have to be interleaved with
-- anything.
--
-- NOTHING BREAKS IF YOU DELAY THIS. The forecast page reads this column in its
-- own small query that degrades to null on a missing-column error, and the save
-- action reports "could not save" instead of throwing. On a database that has
-- not run this file, the reserve card renders read-only and everything else on
-- the page works exactly as before. Nothing 500s.
--
-- NOT A SECURITY CHANGE. No RLS edit: this column lives under the same policies
-- address_line1 and market_value already have (the owner and their household,
-- nobody else). It is never sent to a contractor - every pro-facing read of a
-- home names its columns explicitly, so a new column is exposed nowhere on its
-- own. Worth being deliberate about: "how much cash this homeowner has set
-- aside" is exactly the fact a contractor should not be able to price against.
--
-- ABOUT THE TWO GRANTS AT THE BOTTOM: they are belt and braces, not a fix for a
-- live break. public.properties was deliberately never column-locked the way
-- public.contractors was in 0085 (0095 explains why: too many legitimate app
-- writers, and a wrong allowlist would break real saves), so this column is
-- already writable without them. They are here so that the day somebody DOES
-- column-lock properties, this column is on the allowlist instead of becoming
-- the next silent 42501 - the same half-applied shape 0124, 0128 and 0141 each
-- hit in turn.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0147_repair_reserve.sql >>>>>>>>>>

alter table public.properties
  add column if not exists repair_reserve_cents bigint;

comment on column public.properties.repair_reserve_cents is
  'What the owner says they have set aside toward the next big repair on this home, in cents. Null means they have not told us, which the forecast page treats differently from zero. Per property, not per user. Written only by saveRepairReserveAction (src/app/(app)/forecast/actions.ts), read only by the forecast page. Never exposed to a contractor.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.properties'::regclass
      and conname = 'properties_repair_reserve_cents_range'
  ) then
    alter table public.properties
      add constraint properties_repair_reserve_cents_range
      check (
        repair_reserve_cents is null
        or (repair_reserve_cents >= 0 and repair_reserve_cents <= 1000000000)
      ) not valid;
  end if;
end
$$;

alter table public.properties
  validate constraint properties_repair_reserve_cents_range;

grant insert (repair_reserve_cents) on public.properties to authenticated;
grant update (repair_reserve_cents) on public.properties to authenticated;

-- <<<<<<<<<< END 0147_repair_reserve.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY (run these after the block above; each should match the note)
-- ============================================================================

-- 1. The column exists, is bigint, and is nullable.
--    Expect exactly 1 row: repair_reserve_cents | bigint | YES
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'properties'
--    and column_name = 'repair_reserve_cents';

-- 2. Nothing was backfilled: every existing home is still "has not told us".
--    Expect with_a_value = 0 right after applying.
-- select count(*) as total,
--        count(repair_reserve_cents) as with_a_value
--   from public.properties;

-- 3. The constraint exists AND is validated. Expect one row ending in `t`;
--    an `f` means the validate step did not run and old rows were not checked.
-- select conname, convalidated
--   from pg_constraint
--  where conrelid = 'public.properties'::regclass
--    and conname = 'properties_repair_reserve_cents_range';

-- 4. `authenticated` holds INSERT and UPDATE on the column. Expect two rows.
-- select privilege_type
--   from information_schema.column_privileges
--  where table_schema = 'public'
--    and table_name = 'properties'
--    and column_name = 'repair_reserve_cents'
--    and grantee = 'authenticated'
--  order by privilege_type;

-- 5. RLS is still on and no new policy appeared. Expect properties | true, and
--    the same policy list as before.
-- select relname, relrowsecurity from pg_class where relname = 'properties';
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'properties'
--  order by policyname;

-- 6. The check really bites. Both of these must ERROR. Run them inside a
--    transaction you roll back, against a property uuid you actually own, so
--    nothing real is touched.
-- begin;
--   update public.properties set repair_reserve_cents = -1
--    where id = '<a property uuid you own>';
-- rollback;
--
-- begin;
--   update public.properties set repair_reserve_cents = 1000000001
--    where id = '<a property uuid you own>';
-- rollback;

-- 7. A legitimate value saves. 450000 cents is $4,500.00.
-- begin;
--   update public.properties set repair_reserve_cents = 450000
--    where id = '<a property uuid you own>';
--   select repair_reserve_cents from public.properties
--    where id = '<a property uuid you own>';
-- rollback;

-- 8. End to end, after the deploy: open /forecast as a Hearth Plus member,
--    type an amount into "What you have saved so far", save, and confirm the
--    row moved. Replace the address.
-- select address_line1, repair_reserve_cents
--   from public.properties
--  where address_line1 = '123 Your St';

-- 9. To clear your own figure again (back to "has not told us", not zero):
-- update public.properties
--    set repair_reserve_cents = null
--  where address_line1 = '123 Your St';
