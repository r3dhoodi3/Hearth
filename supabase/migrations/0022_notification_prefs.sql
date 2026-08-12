-- =============================================================================
-- Hearth - notification preferences
-- Stores the homeowner's per-channel notification toggles as a small JSON blob
-- on their user row. The existing "users self update" RLS policy already lets a
-- user write their own row, so no new policy is needed.
-- =============================================================================

alter table public.users
  add column if not exists notification_prefs jsonb not null default '{}'::jsonb;
