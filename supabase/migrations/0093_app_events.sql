-- Minimal analytics sink for /api/track (0091). RUN AGAINST LIVE DB.
-- Server-only: no client can read or write this table directly. The route
-- inserts with the service-role client; RLS stays on with zero policies so
-- even a misconfigured anon/authenticated key can never touch it.
create table if not exists public.app_events (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event      text not null,
  props      jsonb,
  user_id    uuid references public.users(id) on delete set null
);
create index if not exists app_events_event_created_at_idx
  on public.app_events (event, created_at desc);

alter table public.app_events enable row level security;
-- No policies: only the service-role client (in the /api/track route) writes
-- here, and nothing reads it back through a user-facing client today.
