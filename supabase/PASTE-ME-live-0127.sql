-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0127 (2026-08-21)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0126 before this. After running, live is at 0127.
--
-- WHAT THIS IS: one nullable column, properties.unit, so a condo or townhome
-- owner can say which unit is theirs instead of appearing to own the whole
-- building.
--
-- NOTHING BREAKS IF YOU DELAY THIS. The claim insert is written
-- missing-column-safe (claimPropertyAction in src/app/onboarding/actions.ts
-- retries without `unit` on PGRST204/42703) and getProperties falls back to a
-- wide select, so onboarding and every app page keep working on a database
-- that has not run this yet. Until it runs, the unit a homeowner types is
-- simply dropped rather than stored.
--
-- NO DATA CHANGES: no backfill, no constraint, no index. Every existing row is
-- unit-less by definition, address_line1 keeps its exact meaning (the street
-- line, no unit), and nothing looks a home up by its unit.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0127_properties_unit.sql >>>>>>>>>>

alter table public.properties add column if not exists unit text;

comment on column public.properties.unit is
  'Condo/townhome/apartment unit designator for this home ("4B", "Apt 2", "#12"). Null for a single-family home. Kept OUT of address_line1 on purpose: address_line1 is the street line the parcel lookup and the assessor ownership match are run against, while the unit is appended for display only (formatAddressLine in src/lib/property.ts).';

-- <<<<<<<<<< END 0127_properties_unit.sql <<<<<<<<<<

-- Verify (should return one row: unit | text | YES):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'properties'
--      and column_name = 'unit';
