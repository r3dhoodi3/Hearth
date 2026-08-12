-- =============================================================================
-- Hearth - subscription sides (0036)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- One user can hold BOTH memberships at once: homeowner Hearth Plus
-- ("monthly"/"yearly") and contractor Hearth Pro ("pro_monthly"/"pro_yearly").
-- 0022 keyed subscriptions to one row per user, so the two checkout webhook
-- branches (both upserting on user_id) clobbered each other's row while
-- Stripe kept billing both memberships. This adds a `side` column and re-keys
-- the table to one row per (user, side). The Stripe webhook writes side
-- explicitly ('homeowner' for plus_subscription, 'pro' for pro_subscription).
--
-- The 0022 owner-read RLS policy is untouched: users still read only their
-- own rows, now up to one per side.
--
-- Safe to re-run.
-- =============================================================================

-- Every pre-0036 row is one side or the other; default new rows to homeowner
-- so the pre-migration webhook payload (no side field) still inserts cleanly.
alter table public.subscriptions
  add column if not exists side text not null default 'homeowner'
    check (side in ('homeowner', 'pro'));

-- Backfill: pro_ plans are the contractor side. Idempotent and harmless to
-- run every time (re-runs match zero rows).
update public.subscriptions
   set side = 'pro'
 where plan like 'pro\_%' escape '\'
   and side <> 'pro';

-- Re-key: drop 0022's one-row-per-user unique constraint (created inline as
-- `user_id ... unique`, so Postgres named it subscriptions_user_id_key) and
-- replace it with one row per (user, side). The index drop is belt and
-- braces in case the constraint was ever recreated as a bare unique index.
alter table public.subscriptions
  drop constraint if exists subscriptions_user_id_key;
drop index if exists public.subscriptions_user_id_key;

create unique index if not exists subscriptions_user_id_side_key
  on public.subscriptions (user_id, side);
