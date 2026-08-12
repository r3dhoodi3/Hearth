-- =============================================================================
-- Hearth - support messages
-- Homeowners contact support from inside the app instead of email. Each message
-- lands here so the team can read and reply. A homeowner can create and read
-- their own messages; the team reads everything through the service role, which
-- bypasses RLS.
-- =============================================================================

create table public.support_messages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users (id) on delete set null,
  name         text,
  email        text,
  phone        text,
  message      text not null,
  status       text not null default 'open',     -- open, replied, closed
  created_at   timestamptz not null default now()
);
create index support_messages_user_id_idx on public.support_messages (user_id);

alter table public.support_messages enable row level security;

create policy "support self insert" on public.support_messages
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "support self select" on public.support_messages
  for select to authenticated
  using (user_id = auth.uid());
