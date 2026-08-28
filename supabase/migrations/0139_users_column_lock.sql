-- =============================================================================
-- Hearth - lock the columns on public.users that a homeowner must not write
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
-- Run it AFTER 0138 (Part 2 indexes a column 0138 adds to public.reports).
--
-- WHY. Migration 0002 is the only thing standing over public.users:
--
--   create policy "users self update" on public.users
--     for update using (id = auth.uid()) with check (id = auth.uid());
--
-- That is a ROW rule with no column list, and there is no column-level GRANT
-- and no BEFORE UPDATE trigger on the table anywhere in this folder. So
-- Supabase's default table-level grants stand and a signed-in account may
-- rewrite EVERY column of its own row straight through PostgREST, using only
-- the anon key (in the browser bundle by definition) and its own session
-- token:
--
--   curl -X PATCH "$SUPABASE_URL/rest/v1/users?id=eq.$MY_UID" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--     -H "Authorization: Bearer $MY_ACCESS_TOKEN" \
--     -H "Content-Type: application/json" \
--     -d '{"free_doc_reads_used":0,"free_inspection_reads_used":0,
--          "free_quote_used_at":null,"free_plan_used_at":null}'
--
-- One request resets 0135's free-AI-taste paywall (2 lifetime document reads,
-- 1 lifetime inspection import), 0030's free quote check and 0101's free
-- maintenance-plan build. claim_free_ai_taste being atomic and service_role
-- only buys nothing against this: it reads the counter the caller just zeroed.
-- Every one of those features calls a paid vision model on a heavy payload, so
-- this is direct spend, repeatable in a loop.
--
-- The same row also carries `email` (UNIQUE, and match_support_contact keys
-- off it), `sms_consent` / `sms_consent_at` (a TCPA consent record the account
-- could forge or erase) and `referral_code` / `referred_by` (no payout in v1,
-- a landmine the day one ships).
--
-- WHY A TRIGGER AND NOT A COLUMN GRANT. Both work. 0085 uses the grant shape
-- on contractors: revoke the TABLE-level UPDATE, then grant it back per
-- column - which is the only way a column grant means anything, since a bare
-- column-level REVOKE against a standing table-level grant is a no-op (that is
-- exactly why 0078 did nothing). The trigger shape is chosen here because:
--   * it fails LOUD. A grant violation on a PATCH that names a locked column
--     returns 42501 for the whole statement with no indication of which
--     column; the trigger names the offending columns in its message, which is
--     what a future debugging session needs.
--   * it is one object to keep in step with the table instead of two lists
--     (the revoke plus the re-grant) that drift the moment a column is added.
--     A column added later and NOT listed below stays writable - the same
--     default as today, so nothing silently breaks - and adding it to the
--     array is a one-line change.
--   * it does not disturb the table-level grants other code paths rely on.
-- The trigger is the fence either way: it runs BEFORE the row is written, it
-- runs on every UPDATE regardless of where it came from, and it cannot be
-- talked past by an ordinary role.
--
-- LOCKED COLUMNS, and how the list was decided. Every column on public.users,
-- from 0001's CREATE TABLE plus every `alter table public.users add column`
-- since (0022, 0030, 0075, 0101, 0102, 0135, 0137):
--
--   LOCKED (service role only)
--     id                          primary key, never rewritten by anything
--     email                       UNIQUE; identity, and the key
--                                 match_support_contact joins on. The app
--                                 changes a sign-in address through
--                                 supabase.auth.updateUser({ email }), which
--                                 writes auth.users, never this column.
--     created_at                  column default only, never app-written
--     free_doc_reads_used         0135 paywall counter
--     free_inspection_reads_used  0135 paywall counter
--     free_quote_used_at          0030 one free quote check
--     free_plan_used_at           0101 one free maintenance plan
--     sms_consent                 0075 consent record
--     sms_consent_at              0075 consent record
--     referral_code               0102 invite slug (UNIQUE)
--     referred_by                 0102 attribution
--
--   LEFT WRITABLE (a signed-in account's own profile settings, each written
--   today by a user-scoped createClient() call, verified against src/):
--     full_name           src/app/(app)/account/actions.ts saveAccountAction,
--                         src/app/onboarding/actions.ts (~883)
--     phone               saveAccountAction
--     notification_prefs  src/app/(app)/account/notifications/actions.ts
--     guide_seen_at       src/lib/appGuideActions.ts markGuideSeenAction
--     pro_guide_seen_at   same
--
-- THE TWO WRITERS THAT WOULD OTHERWISE HIT A LOCKED COLUMN FROM A SESSION
-- CLIENT ARE ALREADY ON THE ADMIN CLIENT, as of tonight's app-side fix. Both
-- were app bugs this migration would have exposed; both are closed now, so
-- the trigger below changes nothing about how either one behaves:
--
--   1. src/app/(app)/account/actions.ts saveAccountAction (~152-155) writes
--      { sms_consent, sms_consent_at } through createAdminClient(), not the
--      caller's session client. Name and phone (~126-129) still go through
--      the session client, which is correct - those two stay writable by
--      the row's owner. Both writes are scoped to the verified session's
--      own user.id, never an id the form supplied.
--   2. src/lib/referralCode.ts getOrCreateReferralCode (~66-72) writes
--      users.referral_code through createAdminClient() too, also scoped to
--      the verified session's own user.id. It still swallows every error
--      and returns null on failure, so the failure mode stays "the invite
--      link never appears", never a crash.
--
-- Locking both anyway is deliberate defense in depth: a consent record and a
-- referral attribution that the account being measured could rewrite are
-- worth less than nothing, even with the app-side writers already correct.
--
-- ORDER-INDEPENDENT with 0135 and 0137. The list is compared through
-- to_jsonb(NEW)/to_jsonb(OLD), so a column that does not exist yet reads as
-- NULL on both sides, is never "changed", and never raises. Running this
-- before 0135 is harmless; it simply starts enforcing the moment the column
-- appears.
--
-- Idempotent: CREATE OR REPLACE, drop-then-create trigger, IF NOT EXISTS
-- index. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: the guard trigger on public.users
-- =============================================================================
-- SECURITY INVOKER (the default, no `security definer` line): the body reads
-- only NEW and OLD and touches no table, so it needs no privilege of its own,
-- and running as the caller is what makes current_user meaningful below.
--
-- HOW THE SERVICE ROLE IS RECOGNISED. Two independent signals, either one is
-- enough:
--   * the JWT claim. PostgREST puts the verified claims in the
--     `request.jwt.claims` GUC, so `->> 'role'` is what Supabase's own
--     auth.role() reads. Taken through nullif + a sub-block so a missing GUC
--     (a direct psql session) or a malformed one can never throw here.
--   * current_user. PostgREST connects as `authenticator` and then SETs the
--     role named by the token, so an admin-client request really is running as
--     `service_role`. postgres / supabase_admin / supabase_auth_admin are the
--     platform's own roles: the SQL editor and the auth service. Letting them
--     through is not a weakening - anyone holding those credentials can drop
--     this trigger outright - and it is what lets the owner fix a row by hand.
-- Everything else - `authenticated`, `anon`, any future app role - is subject
-- to the list.
create or replace function public.enforce_users_column_lock()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- Keep this in step with the table. A new counter, credit, plan flag,
  -- consent field or identity column on public.users belongs here the day it
  -- is added; anything not listed stays writable by the row's owner, which is
  -- the behaviour that existed before this migration.
  v_locked constant text[] := array[
    'id',
    'email',
    'created_at',
    'free_doc_reads_used',
    'free_inspection_reads_used',
    'free_quote_used_at',
    'free_plan_used_at',
    'sms_consent',
    'sms_consent_at',
    'referral_code',
    'referred_by'
  ];
  v_role    text;
  v_changed text[];
begin
  begin
    v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb
                ->> 'role';
  exception when others then
    v_role := null;
  end;

  if v_role = 'service_role'
     or current_user in ('service_role', 'postgres', 'supabase_admin',
                         'supabase_auth_admin')
  then
    return new;
  end if;

  -- Compared through jsonb rather than named IF branches so the list above is
  -- the single source of truth, and so a column that does not exist on this
  -- database yet reads NULL on both sides instead of failing to compile.
  -- `is distinct from` means a write that re-sends a locked column UNCHANGED
  -- is fine: only an actual change is refused, which keeps a plain profile
  -- save working even when it names more columns than it edits.
  select array_agg(t.col order by t.col)
    into v_changed
    from unnest(v_locked) as t(col)
   where to_jsonb(new) -> t.col is distinct from to_jsonb(old) -> t.col;

  if v_changed is not null then
    raise exception
      'These fields are managed by Hearth and cannot be changed from an account session: %',
      array_to_string(v_changed, ', ')
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists users_column_lock on public.users;
create trigger users_column_lock
  before update on public.users
  for each row execute function public.enforce_users_column_lock();

comment on function public.enforce_users_column_lock() is
  'BEFORE UPDATE guard on public.users. Raises 42501 when a locked column '
  '(paywall counters, consent record, referral attribution, id, email, '
  'created_at) actually changes and the caller is not the service role or a '
  'platform role. "users self update" (0002) is row-scoped with no column '
  'list, so without this a homeowner could reset their own free-AI-taste, '
  'free-quote and free-plan credits with one PATCH.';

comment on trigger users_column_lock on public.users is
  'See enforce_users_column_lock(). Fires on every UPDATE; service-role and '
  'platform-role writes return early, so every admin-client path in the app '
  'is unaffected.';


-- =============================================================================
-- Part 2: one report per account per target
-- =============================================================================
-- reportContentAction (src/lib/reportActions.ts) rate limits at 20 reports an
-- hour per account and confirms the target row exists, but nothing stopped the
-- same account filing the same report against the same review twenty times an
-- hour. The moderation inbox has no dedupe of its own, so that is a cheap way
-- to bury every other report in it.
--
-- PARTIAL, on `target_type is not null`, for two reasons: 0009's chat reports
-- carry a null target and would all collide with each other on (reporter, null,
-- null), and a partial index is the shape that says "this rule is about the
-- 0138 report shape" rather than retro-fitting a constraint onto rows that
-- predate it. Chat reports stay ungated - they are per-thread and already
-- scoped by can_access_lead.
--
-- CANNOT FAIL ON EXISTING DATA when run in order: target_type only exists as
-- of 0138 and no row can have been written with one before this file runs. If
-- you are re-running out of order and it does fail, find the duplicates with
--   select reporter_id, target_type, target_id, count(*)
--     from public.reports where target_type is not null
--    group by 1, 2, 3 having count(*) > 1;
-- and keep the oldest of each group.
create unique index if not exists reports_reporter_target_uniq
  on public.reports (reporter_id, target_type, target_id)
  where target_type is not null;

comment on index public.reports_reporter_target_uniq is
  'One report per account per target (0138 shape only - chat reports carry a '
  'null target_type and are excluded). A repeat report is a 23505, which '
  'reportContentAction should treat as "already reported, thank you" rather '
  'than an error.';


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. The trigger fires on EVERY update of public.users, including the ones the
--    app makes through createAdminClient(). Those run as `service_role` and
--    return early, so nothing on that side changes. Confirm the admin paths
--    still work after pasting: the free-plan claim
--    (src/app/(app)/dashboard/actions.ts ~162), the free-quote claim
--    (src/app/api/analyze-quote/route.ts ~110), the SMS opt-out writer
--    (src/app/api/twilio/inbound/route.ts ~242), the email opt-out writer
--    (src/app/unsubscribe/route.ts ~72) and 0135's two RPCs.
--
-- 2. The two writers named in the header (saveAccountAction's sms_consent
--    write, getOrCreateReferralCode's referral_code write) are already on
--    the admin client, so this trigger does not change their behaviour:
--    both keep working. Spot-check anyway after pasting, since they are the
--    two writers this migration exists to protect - toggling SMS consent on
--    /account should still succeed, and the invite link should still
--    generate.
--
-- 3. The trigger is not a substitute for RLS - "users self select" / "users
--    self update" (0002) still decide WHICH row an account may touch. This
--    only decides which COLUMNS of that row.
--
-- 4. Verify the trigger exists (expect one row: users_column_lock | O):
--      select tgname, tgenabled
--        from pg_trigger
--       where tgrelid = 'public.users'::regclass and not tgisinternal;
--
-- 5. Verify a SERVICE-ROLE write of a locked column still passes. In the SQL
--    editor (which runs as postgres, itself an allowed role), against your own
--    row, restoring the value afterwards:
--      select id, free_doc_reads_used from public.users where id = '<you>';
--      update public.users set free_doc_reads_used = 1 where id = '<you>';
--      update public.users set free_doc_reads_used = 0 where id = '<you>';
--    Both updates must succeed.
--
-- 6. Verify an AUTHENTICATED write of a locked column FAILS. The SQL editor's
--    own role is exempt on purpose, so this has to borrow the `authenticated`
--    role and a matching JWT claim. Paste this block on its own; it rolls its
--    own write back and writes nothing:
--
--      do $v$
--      declare
--        v_user   uuid;
--        v_result text := 'wrote it';
--      begin
--        select id into v_user from public.users limit 1;
--        if v_user is null then
--          raise notice 'SKIP: no rows in public.users';
--          return;
--        end if;
--        begin
--          perform set_config(
--            'request.jwt.claims',
--            json_build_object('sub', v_user, 'role', 'authenticated')::text,
--            true);
--          execute 'set local role authenticated';
--          -- +1, never a fixed value: the guard compares with IS DISTINCT
--          -- FROM, so re-writing the same number would legitimately pass.
--          update public.users
--             set free_doc_reads_used = coalesce(free_doc_reads_used, 0) + 1
--           where id = v_user;
--          if not found then
--            v_result := 'rls filtered the row';
--          end if;
--          -- Always raise, so the subtransaction (and the UPDATE with it) is
--          -- rolled back whatever happened above.
--          raise exception using errcode = 'HRTH1', message = v_result;
--        exception
--          when sqlstate '42501' then v_result := 'refused';
--          when sqlstate 'HRTH1' then null;  -- v_result already says what
--        end;
--        execute 'reset role';
--        perform set_config('request.jwt.claims', '', true);
--        if v_result = 'refused' then
--          raise notice 'PASS: authenticated cannot change a locked column';
--        elsif v_result = 'rls filtered the row' then
--          raise notice
--            'INCONCLUSIVE: auth.uid() did not resolve, so the UPDATE matched '
--            'no row and the trigger never ran. Check by hand from the app.';
--        else
--          raise exception
--            'FAIL: an authenticated session changed users.free_doc_reads_used';
--        end if;
--      end
--      $v$;
--
--    Expected output: NOTICE  PASS: authenticated cannot change a locked
--    column. The UPDATE is rolled back with the inner subtransaction in every
--    branch, so no counter moves.
--
-- 7. Verify an authenticated write of an UNLOCKED column still passes: on
--    /account, change your name and save. It must still work, and the toolbar
--    name must change.
--
-- 8. Verify the report index (expect one row):
--      select indexname, indexdef
--        from pg_indexes
--       where schemaname = 'public'
--         and indexname = 'reports_reporter_target_uniq';
-- =============================================================================
