-- RUN THIS AGAINST THE LIVE DATABASE
-- =============================================================================
-- Hearth - notification center
-- Stores in-app notifications (weather alerts, product recalls, etc.) so a
-- homeowner can see what the app already computes for them without having to
-- revisit the dashboard. Rows are written by trusted server code only (the
-- home-alerts cron job, via the service role), never by the client directly -
-- a user may only read and mark their own rows as read.
-- =============================================================================

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  url        text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_read_idx
  on public.notifications (user_id, read_at);
create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notifications owner read" on public.notifications;
create policy "notifications owner read" on public.notifications
  for select
  using (user_id = auth.uid());

-- No insert policy: rows are only ever created by the cron job's service-role
-- client, which bypasses RLS. A user can still mark their own rows read.
drop policy if exists "notifications owner update" on public.notifications;
create policy "notifications owner update" on public.notifications
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
