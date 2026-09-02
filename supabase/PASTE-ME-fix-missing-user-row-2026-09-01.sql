-- ============================================================================
-- HEARTH HOTFIX 2026-09-01: backfill the missing public.users row
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent. This is NOT a numbered
-- migration; it repairs live data and re-asserts 0011's intended trigger
-- function.
--
-- WHAT HAPPENED. The Apple sign-in account created 2026-09-02 03:30 UTC
-- (snmzdd62kz@privaterelay.appleid.com, id 314fba5c-...) has an auth.users row
-- but NO public.users row, so claiming a home and recording terms both fail
-- with FK violations ("Key is not present in table users"). Every other
-- account (117/118) has its row; an email signup minutes later worked.
-- ============================================================================

-- Part 1: re-assert handle_new_user exactly as migration 0011 defines it,
-- WITH security definer + pinned search_path. If live drifted to security
-- invoker, real signups run the trigger as the auth service role and can fail
-- where the SQL editor (postgres) cannot. Harmless if live already matches.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, phone, full_name)
  values (
    new.id,
    new.email,
    new.phone,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Part 2: backfill EVERY auth user that is missing its public.users row
-- (today: exactly one). Same column mapping the trigger uses.
insert into public.users (id, email, phone, full_name)
select u.id, u.email, u.phone,
       nullif(u.raw_user_meta_data ->> 'full_name', '')
  from auth.users u
  left join public.users p on p.id = u.id
 where p.id is null
on conflict (id) do nothing;

-- ============================================================================
-- VERIFY (run after the paste; both must hold):
-- 1. No auth user is missing its row any more (expect 0):
--      select count(*) from auth.users u
--        left join public.users p on p.id = u.id
--       where p.id is null;
-- 2. The trigger function is security definer (expect: t):
--      select prosecdef from pg_proc
--       where proname = 'handle_new_user'
--         and pronamespace = 'public'::regnamespace;
-- Then, in the app on your phone: claim the house again. It should go
-- through. The terms record will also write itself on your next sign-in.
-- ============================================================================
