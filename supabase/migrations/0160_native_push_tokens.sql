-- =============================================================================
-- OakTend - native push tokens (0160), 2026-09-07 appstore-execute.
-- NOTE: filed as 0156 originally, renamed to 0160 to dodge a same-night numbering
-- collision with two other agents' concurrent 0156/0157 migrations. Verify the
-- final sequence number against whatever supabase/migrations/ looks like once
-- every stream's work lands - a Fable/verifier renumber pass may still move this.
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Included as section 5
-- of supabase/PASTE-ME-ALL-PENDING-2026-09-07.sql (renumbered 0160 by Fable).
-- Safe to apply before the native app exists: nothing in the web app reads or
-- writes this table until the Capacitor build registers a token (see the
-- native branch in src/app/api/push/subscribe/route.ts).
--
-- WHY A SEPARATE TABLE, NOT A COLUMN ON public.push_subscriptions. That
-- table's endpoint/p256dh/auth columns are NOT NULL and web-push-specific
-- (see 0143's own header comment) - a Capacitor push-notifications APNs/FCM
-- token has none of those three fields, so bolting native support onto that
-- table would mean either loosening real NOT NULL constraints the Web Push
-- code depends on, or writing junk placeholder values into columns that are
-- supposed to be real cryptographic material. A parallel table with its own
-- shape is the honest fix.
--
-- WHAT THIS DOES NOT DO YET: nothing in src/lib/push.ts sends to a row in
-- this table - that is real APNs/FCM delivery work (a different signing
-- flow than web-push's VAPID keys entirely) not done in this pass. This
-- migration only makes the STORAGE side ready so
-- src/app/api/push/subscribe/route.ts's native branch has somewhere to
-- write, once a device registers - see that route and
-- src/lib/native/push.ts.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

create table if not exists public.native_push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  side        text check (side in ('homeowner', 'pro')),
  platform    text not null check (platform in ('ios', 'android')),
  -- The raw APNs device token (iOS) or FCM registration token (Android).
  -- Unique per device/registration, same "upsert on the token" idea as
  -- push_subscriptions' unique endpoint - a device that re-registers (app
  -- reinstall, OS-issued token rotation) upserts onto the same row instead
  -- of piling up duplicates.
  token       text not null unique,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists native_push_tokens_user_id_idx
  on public.native_push_tokens (user_id);

alter table public.native_push_tokens enable row level security;

drop policy if exists "native_push_tokens self select" on public.native_push_tokens;
create policy "native_push_tokens self select" on public.native_push_tokens
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "native_push_tokens self insert" on public.native_push_tokens;
create policy "native_push_tokens self insert" on public.native_push_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "native_push_tokens self update" on public.native_push_tokens;
create policy "native_push_tokens self update" on public.native_push_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "native_push_tokens self delete" on public.native_push_tokens;
create policy "native_push_tokens self delete" on public.native_push_tokens
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.native_push_tokens from anon;
grant select, insert, update, delete on public.native_push_tokens to authenticated;
grant all on public.native_push_tokens to service_role;

comment on table public.native_push_tokens is
  'One row per DEVICE that has registered for native push (APNs on iOS, FCM on Android) via @capacitor/push-notifications. Separate from public.push_subscriptions (Web Push/VAPID) because the token shape is different - see the migration header comment. Self-scoped RLS, same pattern as push_subscriptions.';
