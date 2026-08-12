-- =============================================================================
-- Hearth - emergency prep
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Backs the /emergency page's "be ready before it happens" section. Each
-- property gets a jsonb bag keyed by shutoff type (water_shutoff, gas_shutoff,
-- breaker_panel), each value shaped like { photo_path, note }. photo_path is an
-- object path in the existing private home-photos bucket, served through
-- /api/img like every other property photo. Not in database.types.ts yet, so
-- the app casts with `as any` at the query call site until types regenerate.
--
-- Safe to re-run.
-- =============================================================================

alter table public.properties
  add column if not exists emergency_prep jsonb not null default '{}'::jsonb;
