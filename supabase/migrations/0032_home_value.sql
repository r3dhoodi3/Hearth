-- =============================================================================
-- Hearth - home value and equity tracker
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Free feature (src/app/(app)/value): estimates a home's current value by
-- compounding a static, state-level appreciation rate (src/lib/homeValue.ts)
-- from the purchase year to today, then shows equity as that estimate minus
-- the mortgage balance.
--
-- properties already has purchase_date (date, since 0001), so this migration
-- reuses it for the purchase year instead of adding a duplicate column: the
-- form stores the year the owner bought the home as YYYY-01-01. The only
-- fields the table did not already have are what was paid and what is still
-- owed.
--
-- Safe to re-run.
-- =============================================================================

alter table public.properties
  add column if not exists purchase_price numeric;

alter table public.properties
  add column if not exists mortgage_balance numeric;
