-- =============================================================================
-- OakTend - "Other" home system with a free-text name (0156)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Tester feedback B7 (2026-09-07): "Add a system" only offers a fixed list of
-- types (roof, HVAC, water heater, ...). A homeowner with something not on
-- that list (a pool pump, a septic pump, a whole-house generator) had no way
-- to add it at all. This adds an "Other" SYSTEM_TYPES option
-- (src/lib/constants.ts) whose free-text name is stored here.
--
-- home_systems.system_type stays a plain `text` column with NO check
-- constraint (confirmed against 0001_initial_schema.sql before choosing this
-- approach) - it is used as an exact-match key all over the app
-- (SYSTEM_SCHEDULE, REPLACEMENT_INFO, DEFAULT_LIFESPANS, system_lifespans,
-- categoryForSystem, ...), so "other" joins that list as one more known key
-- rather than system_type itself carrying free text. The owner's actual words
-- ("Pool pump", "Septic lift station") live in this new column instead, read
-- back by systemDisplayLabel() (src/lib/constants.ts) which falls back to the
-- plain "Other" label when this column is null, empty, or (until this file is
-- run) simply doesn't exist yet - src/app/(app)/profile/actions.ts writes it
-- through the same "retry the insert/update without the optional columns"
-- fallback the HVAC filter fields and model_number/capacity already use, so
-- adding or editing a system never breaks on a database still behind this
-- migration.
--
-- Safe to re-run.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that isn't caught up -------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'home_systems'
  ) then
    raise exception 'PRECHECK: public.home_systems is missing. Apply migration 0001 before this file. Nothing was changed.';
  end if;
end
$$;

alter table public.home_systems
  add column if not exists other_label text;

comment on column public.home_systems.other_label is
  'Owner-entered free-text name for a system_type = ''other'' row (e.g. "Pool pump"). Ignored for every other system_type. Null-safe: systemDisplayLabel() in src/lib/constants.ts falls back to the plain "Other" label when this is null or blank.';

-- Same 80-character ceiling the app enforces (SystemForm.tsx / SystemRow.tsx
-- maxLength, profile/actions.ts server cap): a belt-and-suspenders backstop,
-- not the primary guard, so a pre-existing longer value (there can't be one
-- yet, but a future direct SQL edit could) is never silently truncated by
-- this migration - only new writes going through the app are capped.
alter table public.home_systems
  drop constraint if exists home_systems_other_label_length;
alter table public.home_systems
  add constraint home_systems_other_label_length check (
    other_label is null or char_length(other_label) <= 80
  );

-- No RLS change: home_systems already has "home_systems owner all" (0002,
-- extended to active household members by 0051, both gated by
-- owns_property()), which covers this new column with no changes.

-- ---- VERIFY -----------------------------------------------------------------
-- select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'home_systems' and column_name = 'other_label';
-- -- expect one row: other_label | text
