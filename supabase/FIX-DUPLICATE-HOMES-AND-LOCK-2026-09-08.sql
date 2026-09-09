-- =============================================================================
-- FIX-DUPLICATE-HOMES-AND-LOCK-2026-09-08.sql   (built by Fable from Landen's query output)
-- Clears the 7 duplicate-address groups, then applies the address lock (0162).
-- One transaction: if anything raises, nothing is applied.
-- BEFORE RUNNING: live must be through 0161 (PART1 file ran with Success).
--
-- What this does, group by group (from DUPLICATE-HOMES-QUERY-2026-09-08 output):
--   A. Blank address (3 enter-bug accounts), 1420 Willow Bend (2 w4/w5 test accounts),
--      742 Evergreen Terrace (8 QA accounts): all throwaway. Accounts DELETED; homes,
--      systems, jobs cascade.
--   B. 17860 Santa Mariana St 92708: three of Landen's own accounts. KEEP the home on
--      landenchu2000@gmail.com; delete the duplicate home rows on landench0@gmail.com
--      and the Apple private-relay account (accounts stay, only their home rows go).
--   C. 16101 Nelson Street 92683 (internal): KEEP test1@hearth.app's home (4 systems),
--      delete pro@hearth.app's empty home row. 17860 Santa Mariana St 94110 (bad zip,
--      internal): KEEP contractor@hearth.com's home, delete pro@hearth.app's empty row.
--   D. 16101 Nelson St 92683: TWO REAL PEOPLE, 784curdo@gmail.com (claimed 09-04) and
--      phongdoe01155@gmail.com (claimed 09-05). Default below: Curtis keeps the home,
--      Phong becomes an active household member of it and Phong's duplicate home row
--      (7 default systems, nothing custom) is deleted. To flip it, swap the two
--      property ids and the two user ids in section D.
--   E. Precheck that no cross-owner duplicates remain, then the 0162 address lock.
-- =============================================================================

do $$ begin
  if to_regclass('public.native_push_tokens') is null then
    raise exception 'PRECHECK FAILED: live is not through 0161 yet. Run PASTE-ME-ALL-PENDING-2026-09-08-PART1.sql first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A. Throwaway accounts (cascade removes their homes, systems, jobs, members)
-- ---------------------------------------------------------------------------
-- A0. Their chat messages first. messages.sender_id is ON DELETE SET NULL, and
-- one July QA message has an oversized body that predates the
-- messages_body_length check, so the cascade's UPDATE trips the check and the
-- whole file rolls back. Deleting the rows outright sidesteps that.
-- The same shape applies to every other column that SET NULLs on user delete
-- (several of those tables also carry NOT VALID checks added later), so all of
-- the throwaway accounts' rows in those tables go first too.
create temp table _throwaway_users on commit drop as
  select id from auth.users where email in (
    'enter-bug-1784104662615@example.com',
    'enter-bug-1784104741287@example.com',
    'enter-bug-1784104765910@example.com',
    'hearth-w4-ho-2026-08-30@example.com',
    'hearth-w5-ho-2026-08-30@example.com',
    'hearthtest1784102021300@mailinator.com',
    'qa.ho.1784102041783@example.com',
    'qa.ho.1784102089234@example.com',
    'qa.ho.1784102408814@example.com',
    'qa.ho.1784102518178@example.com',
    'qa.ho.1784104005369@example.com',
    'qa.ho.1784104117007@example.com',
    'enter-bug-fixed-1784105016684@example.com'
  );

delete from public.message_reactions where user_id in (select id from _throwaway_users);
delete from public.reports where reporter_id in (select id from _throwaway_users);
delete from public.learning_requests where user_id in (select id from _throwaway_users);
delete from public.support_messages where user_id in (select id from _throwaway_users)
   or matched_user_id in (select id from _throwaway_users);
delete from public.app_events where user_id in (select id from _throwaway_users);
delete from public.contractors where user_id in (select id from _throwaway_users);

delete from public.messages where sender_id in (
  select id from auth.users where email in (
    'enter-bug-1784104662615@example.com',
    'enter-bug-1784104741287@example.com',
    'enter-bug-1784104765910@example.com',
    'hearth-w4-ho-2026-08-30@example.com',
    'hearth-w5-ho-2026-08-30@example.com',
    'hearthtest1784102021300@mailinator.com',
    'qa.ho.1784102041783@example.com',
    'qa.ho.1784102089234@example.com',
    'qa.ho.1784102408814@example.com',
    'qa.ho.1784102518178@example.com',
    'qa.ho.1784104005369@example.com',
    'qa.ho.1784104117007@example.com',
    'enter-bug-fixed-1784105016684@example.com'
  )
);

delete from auth.users where email in (
  'enter-bug-1784104662615@example.com',
  'enter-bug-1784104741287@example.com',
  'enter-bug-1784104765910@example.com',
  'hearth-w4-ho-2026-08-30@example.com',
  'hearth-w5-ho-2026-08-30@example.com',
  'hearthtest1784102021300@mailinator.com',
  'qa.ho.1784102041783@example.com',
  'qa.ho.1784102089234@example.com',
  'qa.ho.1784102408814@example.com',
  'qa.ho.1784102518178@example.com',
  'qa.ho.1784104005369@example.com',
  'qa.ho.1784104117007@example.com',
  'enter-bug-fixed-1784105016684@example.com'
);

-- ---------------------------------------------------------------------------
-- B. Landen's duplicate home rows (accounts kept)
-- ---------------------------------------------------------------------------
delete from public.properties where id in (
  '63ed6bc9-8b08-4982-87a4-361a7e0230f3',  -- landench0@gmail.com, 17860 Santa Mariana St
  'e3596ff5-087e-4eda-975b-db0bc4d0244d'   -- 8hffydtkvr@privaterelay.appleid.com, same address
);

-- ---------------------------------------------------------------------------
-- C. Internal test duplicates: pro@hearth.app's two empty home rows
-- ---------------------------------------------------------------------------
delete from public.properties where id in (
  'd42b01f8-b3ad-46f4-8e1d-d7d9d07751fa',  -- pro@hearth.app, 16101 Nelson Street 92683 (0 systems)
  'd0dc1402-ba40-49dd-8915-2c59fc601c8b'   -- pro@hearth.app, 17860 Santa Mariana St 94110 (0 systems)
);

-- ---------------------------------------------------------------------------
-- D. 16101 Nelson St 92683: Curtis keeps the home, Phong joins it as a member
-- ---------------------------------------------------------------------------
insert into public.household_members (property_id, invited_email, member_user_id, status, invited_by, accepted_at)
values (
  '38f0ca4d-19c6-4d34-ad81-de4cc9b96c1a',          -- Curtis's home
  'phongdoe01155@gmail.com',
  '1ff0dc7c-a32a-46fd-bae6-33cd312cb3a6',          -- Phong's user id
  'active',
  '13586d3d-824b-431b-877d-52e63c221e52',          -- Curtis's user id (as inviter)
  now()
)
on conflict do nothing;

delete from public.properties where id = '64e76808-b4ef-4395-96cf-a2b51680fd4f';  -- Phong's duplicate home

-- ---------------------------------------------------------------------------
-- E. Nothing left? Then the address lock (0162, verbatim from the 09-07 file).
-- ---------------------------------------------------------------------------
do $$
declare v_left int;
begin
  select count(*) into v_left from (
    select 1 from public.properties
    group by lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')), coalesce(zip,''),
             lower(regexp_replace(btrim(coalesce(unit,'')), '\s+', ' ', 'g'))
    having count(*) > 1
  ) d;
  if v_left > 0 then
    raise exception 'PRECHECK FAILED: % duplicate address group(s) still exist after cleanup; re-run DUPLICATE-HOMES-QUERY-2026-09-08.sql and send Fable the output.', v_left;
  end if;
end $$;

-- =============================================================================
-- 0162_properties_address_unique_global.sql
-- one owner per normalized address (B8). Safe to re-run.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'properties'
  ) then
    raise exception 'PRECHECK: public.properties is missing. Apply migration 0001 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'properties' and column_name = 'unit'
  ) then
    raise exception 'PRECHECK: public.properties.unit is missing. Apply migration 0127 before this file. Nothing was changed.';
  end if;
end
$$;

-- The key expressions mirror the app-level guard in claimPropertyAction
-- CHARACTER FOR CHARACTER: trim, collapse internal whitespace, lowercase.
create unique index if not exists properties_address_unique
  on public.properties (
    lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')),
    coalesce(zip, ''),
    lower(regexp_replace(btrim(coalesce(unit, '')), '\s+', ' ', 'g'))
  );

comment on index public.properties_address_unique is
  'B8: one home per (normalized street line, zip, unit), across EVERY owner - '
  'not just per user like properties_owner_address_unique (0151). Backstop to '
  'the app-level address-lock guard in claimPropertyAction '
  '(src/app/onboarding/actions.ts) against two different accounts both '
  'claiming the same home as owner. Household invites are unaffected: they '
  'add a household_members row against the existing property, never a second '
  'properties row.';

-- ---- VERIFY (read-only, run after) -----------------------------------------
-- select indexname from pg_indexes where tablename='properties' and indexname='properties_address_unique';
-- -- expect one row.
