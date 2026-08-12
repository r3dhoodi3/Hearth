-- =============================================================================
-- Hearth - consumables autopilot v1 (HVAC filter reminders)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Owner-entered consumable details on home systems: the filter size (e.g.
-- "16x25x1") and how often to remind (every 1/2/3/6/12 months). Powers the
-- filter-reminders cron. Only meaningful for hvac systems today, but the
-- columns are kept generic so other consumables (fridge water filters,
-- softener salt) can reuse them later.
--
-- Safe to re-run.
-- =============================================================================

alter table public.home_systems
  add column if not exists filter_size text,
  add column if not exists filter_interval_months int;

comment on column public.home_systems.filter_size is
  'Owner-entered filter size, e.g. "16x25x1". Powers filter reminders. Only meaningful for hvac systems today but kept generic.';

comment on column public.home_systems.filter_interval_months is
  'Owner-entered reminder cadence in months (e.g. every 3 months). Powers filter reminders. Only meaningful for hvac systems today but kept generic.';
