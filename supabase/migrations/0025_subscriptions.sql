-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL Editor)
-- =============================================================================
-- Hearth - Hearth Plus subscriptions (0022)
-- Tracks the homeowner's Stripe subscription status so the app can gate
-- "finding a pro" (posting a job / contacting pros) behind an active Hearth
-- Plus plan. Rows are written only by the Stripe webhook via the service-role
-- client (checkout completion, renewal, cancellation) - a user may only read
-- their own row.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references auth.users (id) on delete cascade,
  stripe_customer_id    text,
  stripe_subscription_id text,
  status                text not null default 'inactive',
  plan                  text,
  current_period_end    timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_stripe_subscription_id_idx
  on public.subscriptions (stripe_subscription_id);

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions owner read" on public.subscriptions;
create policy "subscriptions owner read" on public.subscriptions
  for select to authenticated
  using (user_id = auth.uid());

-- No insert/update policy: rows are only ever written by the Stripe webhook's
-- service-role client, which bypasses RLS.
