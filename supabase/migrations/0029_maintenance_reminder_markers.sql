-- =============================================================================
-- Hearth - maintenance reminder markers
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Tracks when a task last triggered an "upcoming" or "overdue" reminder so the
-- daily cron (src/app/api/cron/maintenance-reminders) never notifies twice for
-- the same threshold. Written only by the cron's service-role client; the
-- existing owner RLS policy on maintenance_tasks already covers reads.
-- =============================================================================

alter table public.maintenance_tasks
  add column if not exists reminded_upcoming_at timestamptz,
  add column if not exists reminded_overdue_at  timestamptz;
