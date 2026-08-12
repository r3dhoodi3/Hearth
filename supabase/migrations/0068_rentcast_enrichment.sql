-- =============================================================================
-- Hearth - RentCast enrichment at onboarding (0066)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Idempotent and safe to
-- re-run.
--
-- RentCast's /v1/properties and /v1/avm/value responses carry more than the
-- baseline facts properties already stores (address, year built, sqft,
-- beds/baths, lot size, property type). This migration adds columns for the
-- rest of what onboarding now ingests: geocoding, HOA, county, the property's
-- full tax-assessment history, and RentCast's automated market valuation.
-- purchase_date/purchase_price/assessed_value/assessed_year already exist
-- (0001, 0029, 0039) and start getting filled by onboarding now too, but need
-- no schema change here.
--
-- No RLS changes: properties already has "owner selects/updates own property"
-- policies (0002), which cover these new columns with no changes.
-- =============================================================================

alter table public.properties
  add column if not exists latitude numeric;

alter table public.properties
  add column if not exists longitude numeric;

alter table public.properties
  add column if not exists hoa_fee numeric;

alter table public.properties
  add column if not exists county text;

alter table public.properties
  add column if not exists property_tax_history jsonb;

alter table public.properties
  add column if not exists market_value numeric;

alter table public.properties
  add column if not exists market_value_low numeric;

alter table public.properties
  add column if not exists market_value_high numeric;

comment on column public.properties.latitude is
  'Property latitude from RentCast at onboarding.';

comment on column public.properties.longitude is
  'Property longitude from RentCast at onboarding.';

comment on column public.properties.hoa_fee is
  'HOA fee reported by RentCast at onboarding, if any.';

comment on column public.properties.county is
  'County from RentCast''s property record at onboarding.';

comment on column public.properties.property_tax_history is
  'Full year-by-year property tax history from RentCast at onboarding: [{year, amount}, ...].';

comment on column public.properties.market_value is
  'RentCast AVM estimated market value at onboarding.';

comment on column public.properties.market_value_low is
  'RentCast AVM low end of the estimated value range at onboarding.';

comment on column public.properties.market_value_high is
  'RentCast AVM high end of the estimated value range at onboarding.';
