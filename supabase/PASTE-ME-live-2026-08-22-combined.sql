-- Hearth live DB: everything new since migration 0126 (live as of 2026-08-21).
-- Paste the CONTENTS of this file into Supabase > SQL Editor > New query > Run.
-- Safe to run twice (every statement is "if not exists").
-- Source of truth: supabase/migrations/0127_properties_unit.sql,
--                  supabase/migrations/0128_contractor_review_link_grants.sql

-- 0127: condo/townhome unit number on a home
alter table public.properties add column if not exists unit text;
comment on column public.properties.unit is
  'Optional unit or apartment number (e.g. 4B). address_line1 stays the bare street line; formatAddressLine() appends the unit for display.';

-- Verify: expect one row named "unit"
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'properties' and column_name = 'unit';

-- Data fix: a pro row ("Wills Business", id 0eee88b7...) carries a profane
-- custom service category that shows on its public profile and in Browse Pros.
-- Removes only that one array element; the row and its canonical categories stay.
update public.contractors
set categories = array_remove(categories, 'Suck Dick')
where left(id::text, 8) = '0eee88b7' and 'Suck Dick' = any(categories);
-- Verify: expect 0 rows
select left(id::text, 8) as id, name, categories from public.contractors
where 'Suck Dick' = any(categories);


-- =============================================================================
-- 0128: review-link column grants + properties address length cap
-- =============================================================================
-- WHY THIS IS THE BLOCKER: 0085 revoked the TABLE-level update/insert on
-- contractors and re-granted both by explicit column list. 0113 later added
-- yelp_url and google_reviews_url without extending that list. The pro profile
-- form posts BOTH fields on every save, so every POST /pro/profile has been
-- failing with "permission denied for table contractors" (42501) since 0113.
-- Extends 0085's allowlist by exactly those two columns, nothing else. `slug`
-- is deliberately NOT granted: no user-scoped call site writes it today.
grant update (yelp_url, google_reviews_url) on public.contractors to authenticated;
grant insert (yelp_url, google_reviews_url) on public.contractors to authenticated;

-- Verify: expect 4 rows - INSERT and UPDATE for each of the two columns.
select table_name, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'contractors'
  and column_name in ('yelp_url', 'google_reviews_url')
  and grantee = 'authenticated'
order by column_name, privilege_type;

-- properties.address_line1 has no ceiling in the DB. 200 matches the cap the
-- browser form and claimPropertyAction already apply, so this rejects nothing
-- an honest claim produces. NOT VALID first (brief lock, enforces immediately
-- on new writes), then VALIDATE scans the existing rows without blocking them.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.properties'::regclass
      and conname = 'properties_address_line1_len'
  ) then
    alter table public.properties
      add constraint properties_address_line1_len
      check (char_length(address_line1) <= 200) not valid;
  end if;
end
$$;

alter table public.properties validate constraint properties_address_line1_len;

-- Verify: expect one row, convalidated = true
select conname, convalidated from pg_constraint
where conrelid = 'public.properties'::regclass
  and conname = 'properties_address_line1_len';

-- Cleanup: the four throwaway audit accounts used on 08-21/22 (hearth-audit-p1..p4@example.com).
-- Deleting the auth users cascades to their public rows (properties, home_systems,
-- contractors "Luis Plumbing Co" and "Mia Fixes Things", clients, leads) where FKs cascade.
-- Run AFTER you are done testing with them. Expect: DELETE 4.
delete from auth.users where email like 'hearth-audit-p%@example.com' or email like 'hearth-audit-suggest%@mailinator.com';
-- Verify: expect 0 rows
select email from auth.users where email like 'hearth-audit-p%@example.com';
