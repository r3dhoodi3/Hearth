-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0143 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0142 before this. After running, live is at 0143.
--
-- WHAT THIS IS: one new table, public.push_subscriptions, which is what lets
-- Hearth notify somebody on their phone WITH THE APP CLOSED. Today the only
-- ways to reach a person are the bell inside the app and (once the provider
-- keys exist) email and SMS. This is the third channel, it costs nothing per
-- message, and it is free for homeowners and pros alike.
--
-- NOTHING ELSE IN THE DATABASE CHANGES. No existing table, policy, function or
-- grant is touched. The push opt-out preference rides in the users.
-- notification_prefs jsonb that already exists, so it needs no column.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/lib/push.ts treats a missing table as
-- "push is not wired up yet" and returns quietly; the subscribe API answers
-- 503 and the button says it could not save. The bell, email and SMS are all
-- unaffected. Nobody sees an error page.
--
-- THE OTHER HALF IS THREE ENV VARS IN VERCEL. Without them push stays dormant
-- even with this table in place - see docs/GO-LIVE-WIRING.md section 10:
--   NEXT_PUBLIC_VAPID_PUBLIC_KEY
--   VAPID_PRIVATE_KEY
--   VAPID_SUBJECT
-- ============================================================================

-- >>>>>>>>>> BEGIN 0143_push_subscriptions.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - Web Push subscriptions (0143)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY THIS EXISTS
-- Until now Hearth could only reach someone who had the app OPEN: the bell in
-- the nav, and a toast that polls every 45 seconds. Close the app and a quote
-- request or a message sat there unseen. This table is what makes the phone
-- itself buzz.
--
-- WHAT A ROW IS. When somebody taps "Turn on notifications", their browser
-- creates a PushSubscription: an `endpoint` URL at their browser vendor's own
-- push service (Apple, Google, Mozilla) plus two keys the push service uses to
-- carry an encrypted payload. One row per DEVICE, not per person - the same
-- account on a phone and a laptop is two rows. The server posts a message to
-- the endpoint; the push service wakes the device; public/sw.js shows it.
--
-- WHAT IS AND IS NOT SENSITIVE HERE. The endpoint is a capability URL: anyone
-- holding it can ask that push service to wake that device, though they cannot
-- read anything and cannot produce a notification that looks like Hearth's
-- without Hearth's VAPID private key (which lives only in the server env).
-- `p256dh` and `auth` are PUBLIC halves - the matching private key never leaves
-- the browser, which is what makes the payload readable only on that device.
-- Still: an endpoint identifies a device, so this table is self-scoped under
-- RLS and revoked from anon entirely.
--
-- The DELETE half of the policy set matters as much as the insert: turning
-- notifications off has to actually remove the row, or "off" is a lie the
-- server keeps ignoring.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/lib/push.ts treats a missing table as
-- "push is not wired up yet" (isMissingSchemaError) and returns quietly, the
-- subscribe API answers 503, and the in-app bell, email and SMS are all
-- untouched. The only thing that happens is that the "Turn on notifications"
-- button reports it could not save.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Which shell the person was in when they turned notifications on. Not used
  -- to decide anything today (a push goes to every device the account has, and
  -- the same human can be both a homeowner and a pro on one account), but it
  -- is the difference between "we can tell where this came from" and a support
  -- question nobody can answer. Nullable: an older client that does not send it
  -- still subscribes successfully.
  side        text check (side in ('homeowner', 'pro')),
  -- THE identity of a device, and the reason for the unique constraint. A
  -- browser hands back the SAME endpoint every time until the subscription is
  -- revoked, so an upsert on this column is what keeps a person who taps the
  -- button on five different days at exactly one row rather than five. Without
  -- the constraint the upsert in src/app/api/push/subscribe has nothing to
  -- conflict on and every visit would add another duplicate buzz.
  endpoint    text not null unique,
  -- The browser's public encryption key and auth secret for this subscription.
  -- Opaque base64url strings from the PushSubscription; the server only ever
  -- hands them straight back to the web-push library.
  p256dh      text not null,
  auth        text not null,
  -- Purely diagnostic: "which device is this" when somebody says notifications
  -- stopped working. Never parsed, never used in a decision.
  user_agent  text,
  created_at  timestamptz not null default now(),
  -- Stamped on every successful re-subscribe, which the app does on each visit
  -- once permission is granted (see src/components/PushRegistrar.tsx). A row
  -- whose last_used_at has not moved in months belongs to a device that stopped
  -- coming back, and is a candidate for cleanup later.
  last_used_at timestamptz
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Self-scoped, all four verbs a person needs for their own devices and nothing
-- more. There is no policy that lets one account see another's rows, so the
-- endpoint list is not enumerable from the browser: the service role (which
-- bypasses RLS) is what actually sends, in src/lib/push.ts.
drop policy if exists "push_subscriptions self select" on public.push_subscriptions;
create policy "push_subscriptions self select" on public.push_subscriptions
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "push_subscriptions self insert" on public.push_subscriptions;
create policy "push_subscriptions self insert" on public.push_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid());

-- UPDATE is needed as well as INSERT because the API upserts on `endpoint`: a
-- device that re-subscribes with rotated keys takes the UPDATE branch. Both
-- USING and WITH CHECK are pinned to auth.uid(), so an update can neither reach
-- somebody else's row nor hand one of yours to another account.
drop policy if exists "push_subscriptions self update" on public.push_subscriptions;
create policy "push_subscriptions self update" on public.push_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "push_subscriptions self delete" on public.push_subscriptions;
create policy "push_subscriptions self delete" on public.push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid());

-- Grants in the same shape as 0138's user_blocks: nothing at all for anon (this
-- is a signed-in-only feature and an anonymous visitor has no devices to
-- register), the four self-scoped verbs for authenticated, everything for the
-- service role, which is the only thing that reads across accounts in order to
-- send.
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

comment on table public.push_subscriptions is
  'One row per DEVICE that has agreed to receive Web Push from Hearth (browser push endpoint plus its public encryption keys). Self-scoped RLS: an account can only see, create, refresh and delete its own rows, and anon has none at all. The service role reads across accounts to send - see src/lib/push.ts and public/sw.js.';

-- <<<<<<<<<< END 0143_push_subscriptions.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY (run these after the bundle above; each should answer as described)
-- ============================================================================
--
-- 1. The table exists with the columns the app expects (11 rows: id, user_id,
--    side, endpoint, p256dh, auth, user_agent, created_at, last_used_at):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--    order by ordinal_position;
--
-- 2. RLS is ON and there are exactly FOUR self-scoped policies
--    (select/insert/update/delete, all qualified by auth.uid()):
--   select relname, relrowsecurity
--     from pg_class where relname = 'push_subscriptions';
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.push_subscriptions'::regclass
--    order by polname;
--
-- 3. anon has NO privileges on it, authenticated has the four verbs, and
--    service_role has everything (anon must not appear at all):
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--    order by grantee, privilege_type;
--
-- 4. The endpoint uniqueness that makes the upsert work is really there
--    (should return one unique constraint or index on (endpoint)):
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public' and tablename = 'push_subscriptions';
--
-- 5. Once the env vars are set and somebody has tapped "Turn on
--    notifications", there should be a row per device (service role only):
--   select side, count(*), max(created_at), max(last_used_at)
--     from public.push_subscriptions group by side;
--    - zero rows is the correct answer until someone turns it on.
--    - endpoints starting web.push.apple.com are iPhones with Hearth added to
--      the Home Screen; fcm.googleapis.com is Android/Chrome.
--
-- 6. Nobody has opted out yet (service role only). push_opt_out lives in the
--    same jsonb as the email opt-out:
--   select count(*) from public.users
--    where notification_prefs ->> 'push_opt_out' = 'true';
-- ============================================================================
