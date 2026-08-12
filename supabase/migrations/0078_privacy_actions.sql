-- Durable audit log of privacy-rights actions (delete/export). RUN AGAINST LIVE DB.
-- CRITICAL: user_id has NO cascading FK - this row MUST survive the account
-- deletion it records (a FK ON DELETE CASCADE to auth.users would delete the
-- audit trail along with the user, defeating the purpose).
create table if not exists public.privacy_actions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,            -- deliberately no FK; the user may be deleted
  action     text not null check (action in ('delete','export')),
  summary    jsonb,                    -- the EraseSummary (delete) or a category count (export)
  created_at timestamptz not null default now()
);
create index if not exists privacy_actions_user_idx on public.privacy_actions (user_id);
alter table public.privacy_actions enable row level security;
-- No client policies: written only by the service-role (admin) client below.
