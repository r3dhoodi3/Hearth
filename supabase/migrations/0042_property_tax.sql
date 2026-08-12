-- =============================================================================
-- Hearth - property tax watch and appeal kit
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Powers the /taxes page: the homeowner copies two numbers off their county
-- assessment notice (the assessed value and the assessment year), and Hearth
-- compares that assessment against its own estimated market value from the
-- home value tracker (src/lib/homeValue.ts, compounding a state-level rate
-- from purchase_price and purchase_date). When the assessment runs well above
-- the estimate, the page flags it and Plus members can draft an appeal letter.
--
-- properties already has everything else this feature needs (purchase price
-- and date from 0029 and 0001), so the only new fields are the two the owner
-- reads off the notice. The existing "owner selects/updates own property" RLS
-- policies cover both columns.
--
-- Safe to re-run.
-- =============================================================================

alter table public.properties
  add column if not exists assessed_value numeric;

alter table public.properties
  add column if not exists assessed_year int;

comment on column public.properties.assessed_value is
  'Assessed value the owner copied from their county property assessment notice. Compared against Hearth''s estimated market value on /taxes.';

comment on column public.properties.assessed_year is
  'Year of the county assessment the owner entered (the tax year on the notice), shown alongside the comparison on /taxes.';
