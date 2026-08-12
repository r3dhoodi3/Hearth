-- =============================================================================
-- Hearth - first maintenance-plan build free
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Every homeowner gets exactly one free maintenance-plan build as a taste of
-- Hearth Plus, mirroring the free quote check (free_quote_used_at, migration
-- 0027). Null means the credit is unused; generateMaintenancePlanAction stamps
-- it (service-role client) the first time a non-Plus user actually builds a
-- plan, and refunds it if that build adds no new tasks. The existing "users
-- self select" RLS policy already covers reads.
--
-- Safe to re-run.
-- =============================================================================

alter table public.users
  add column if not exists free_plan_used_at timestamptz;
