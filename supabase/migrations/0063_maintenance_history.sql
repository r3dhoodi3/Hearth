-- =============================================================================
-- Hearth - honest maintenance history (0061)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- The home report's maintenance history must never be AI-invented or
-- inferred - every row is something the owner actually logged or checked
-- off. This adds the optional cost + who-did-it fields the "log something
-- you had done" form in the home report writes (see
-- src/app/(app)/home-report/actions.ts, addMaintenanceHistoryAction), and a
-- unique index so the same real-world event (same property, same title, same
-- completed day) can never be inserted twice. The action already guards this
-- in application code before insert; this index is the belt-and-suspenders
-- backstop at the database level.
--
-- If this fails with a uniqueness violation, some existing rows already
-- collide (same property + title + completed day). Find and resolve those by
-- hand before re-running:
--   select property_id, lower(title), completed_at::date, count(*)
--   from public.maintenance_tasks
--   where status = 'done' and completed_at is not null
--   group by 1, 2, 3 having count(*) > 1;
--
-- No RLS changes: maintenance_tasks already has "maintenance_tasks owner
-- all" (0002, gated by owns_property()), which covers these new columns with
-- no changes.
--
-- Safe to re-run once no duplicates remain.
-- =============================================================================

alter table public.maintenance_tasks
  add column if not exists cost_cents int,
  add column if not exists performed_by text;

comment on column public.maintenance_tasks.cost_cents is
  'Owner-entered cost in cents for this maintenance event, optional. Set from the home report "log history" form.';

comment on column public.maintenance_tasks.performed_by is
  'Owner-entered pro/vendor name for this maintenance event, optional free text (not a contractor_id - the owner may have used someone off-platform).';

-- The day component pins the completion timestamp to a UTC calendar day.
-- A bare completed_at::date cast depends on the session TimeZone (only
-- STABLE), which Postgres rejects inside an index expression (42P17);
-- "at time zone 'utc'" first makes the cast IMMUTABLE and deterministic.
create unique index if not exists maintenance_tasks_history_dedupe_idx
  on public.maintenance_tasks (property_id, lower(title), (((completed_at at time zone 'utc'))::date))
  where status = 'done' and completed_at is not null;
