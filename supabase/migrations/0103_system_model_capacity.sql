-- =============================================================================
-- Hearth - exact model number + capacity on a home system
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- The system form only offered a brand dropdown (material_or_model). DIY owners
-- want to record the exact model number off the data plate and the capacity /
-- size (e.g. "50 gal", "3 ton", "200 sq ft"), so this adds two optional
-- free-text columns. Both are plain text with no constraint: they are owner
-- notes, displayed as-is on the system row when present. addSystemAction,
-- updateSystemAction, and the walkthrough confirm flow write them; a DB missing
-- these columns degrades gracefully (the actions retry without them) so the
-- form never breaks before this runs.
--
-- Safe to re-run.
-- =============================================================================

alter table public.home_systems
  add column if not exists model_number text;

alter table public.home_systems
  add column if not exists capacity text;

comment on column public.home_systems.model_number is
  'Optional owner-entered exact model number off the data plate. Free text, '
  'displayed as-is. See src/app/(app)/profile/SystemForm.tsx.';

comment on column public.home_systems.capacity is
  'Optional owner-entered capacity / size, e.g. "50 gal", "3 ton", "200 sq ft". '
  'Free text, displayed as-is. See src/app/(app)/profile/SystemForm.tsx.';
