-- RUN THIS AGAINST THE LIVE DATABASE
-- =============================================================================
-- Hearth - Ask Hearth daily usage limits (0024)
-- Tracks how many Ask Hearth requests each homeowner makes per day so the
-- paid Gemini API can't be abused. One row per user per day, incremented by
-- the /api/ask route's service-role client - a user may only read their own
-- rows. No client write policy: counts are only ever written server-side.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.ai_usage (
  user_id    uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  count      int not null default 0,
  primary key (user_id, usage_date)
);

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage owner read" on public.ai_usage;
create policy "ai_usage owner read" on public.ai_usage
  for select
  using (user_id = auth.uid());

-- No insert/update policy: rows are only ever written by the /api/ask route's
-- service-role client, which bypasses RLS.
