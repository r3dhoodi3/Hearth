-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0145 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: two free AI back-office drafts for every contractor account,
-- then the Hearth Pro wall. One new column on public.contractors
-- (free_tool_drafts_used) and the atomic claim/refund pair that spends it,
-- exactly the shape migration 0135 gave the homeowner side's document and
-- inspection reads.
--
-- WHY IT MATTERS: before this, /pro/tools was members-only with no way to see
-- what a draft even looks like. A pro was being asked to pay for the idea of a
-- product. Now they get two real ones.
--
-- ORDER: run this AFTER 0144. It only needs public.contractors, which has been
-- live since the beginning, so the order is a convenience rather than a
-- dependency. Nothing later depends on it.
--
-- IF YOU DELAY THIS: nothing breaks and nobody sees an error page. The app
-- notices the function is missing and FAILS OPEN for the drafts (a
-- previously-members-only feature stays usable rather than telling a pro they
-- spent a taste the database cannot prove they spent), logging one warning line
-- naming this file. Members are unaffected either way. The gate closes the
-- moment this runs.
--
-- THERE IS DELIBERATELY NO GRANT ON THE NEW COLUMN. Migration 0085 revoked
-- table-level INSERT and UPDATE on public.contractors from authenticated and
-- anon and re-granted a hard-coded column allowlist. Leaving this column off
-- that list is what stops a signed-in pro from PATCHing their own counter back
-- to zero. Do NOT "fix" this by adding a grant. (0141 needed the opposite:
-- owner_name is a field a pro fills in themselves.)
-- ============================================================================

-- >>>>>>>>>> BEGIN 0145_pro_free_tool_drafts.sql >>>>>>>>>>

alter table public.contractors
  add column if not exists free_tool_drafts_used integer not null default 0;

comment on column public.contractors.free_tool_drafts_used is
  'Lifetime AI back-office drafts a non-member contractor has spent. Claimed by claim_pro_free_taste, handed back by refund_pro_free_taste when the model call fails. Not writable by authenticated: migration 0085 re-granted contractors column by column and this column is deliberately not on that list.';

-- Claim one taste, ATOMICALLY.
--
-- WHY A FUNCTION. supabase-js sends literal values in an update, so it cannot
-- express `col = col + 1`; a read-then-write from the app would let two
-- parallel requests both pass the same check and each spend a taste that was
-- never there. This does the read and the write in one statement, with the
-- limit in the WHERE clause, so exactly p_limit claims can ever succeed no
-- matter how many requests arrive at once. Same guarantee, and the same shape,
-- as claim_free_ai_taste (0135).
--
-- Returns true when this caller got a taste, false when they are out (or the
-- contractor row is missing). The app treats false as the paywall.
--
-- INVOKER, deliberately (no `security definer` line - invoker is Postgres's
-- default), following 0135. EXECUTE is granted to service_role ONLY, and
-- service_role already carries BYPASSRLS, so definer would add no capability
-- while turning one stray `grant execute ... to authenticated` from a
-- permission error into a privilege escalation on public.contractors. The
-- atomicity that matters comes from the single conditional UPDATE below.
-- `set search_path = public` pins the schema this body resolves against no
-- matter who calls it. Postgres grants EXECUTE on a new function to PUBLIC, so
-- that grant is revoked explicitly.
create or replace function public.claim_pro_free_taste(
  p_contractor uuid,
  p_limit integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_contractor is null or p_limit is null or p_limit <= 0 then
    return false;
  end if;

  update public.contractors
     set free_tool_drafts_used = coalesce(free_tool_drafts_used, 0) + 1
   where id = p_contractor
     and coalesce(free_tool_drafts_used, 0) < p_limit;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.claim_pro_free_taste(uuid, integer) is
  'Atomically spend one free AI back-office draft for p_contractor while under p_limit. True when claimed. Service role only.';

-- The grant is the LAST thing said about this function, deliberately: whoever
-- reads or edits this block should see the full role list with nothing after
-- it that could be mistaken for a second grant.
revoke all on function public.claim_pro_free_taste(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pro_free_taste(uuid, integer)
  to service_role;

-- Hand a claimed taste back when the model call never produced a document: a
-- thrown request, a ceiling above the caller, an unusable draft. Same thinking
-- as refund_free_ai_taste (0135) and refundAiUsage in src/lib/aiUsage.ts,
-- which is why the app claims up front (race-proof) and refunds on failure
-- rather than counting afterwards. Never drives the counter below zero.
--
-- INVOKER for the same reason as claim_pro_free_taste above.
create or replace function public.refund_pro_free_taste(
  p_contractor uuid
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_contractor is null then
    return;
  end if;

  update public.contractors
     set free_tool_drafts_used = greatest(coalesce(free_tool_drafts_used, 0) - 1, 0)
   where id = p_contractor;
end;
$$;

comment on function public.refund_pro_free_taste(uuid) is
  'Hand back one free AI back-office draft for p_contractor after a failed model call. Never goes below zero. Service role only.';

-- Grant last, same reasoning as claim_pro_free_taste above.
revoke all on function public.refund_pro_free_taste(uuid)
  from public, anon, authenticated;
grant execute on function public.refund_pro_free_taste(uuid)
  to service_role;

-- <<<<<<<<<< END 0145_pro_free_tool_drafts.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the bundle above; each says what it should return.
-- ============================================================================

-- 1. The column is there, integer, not null, defaulting to 0.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'contractors'
   and column_name = 'free_tool_drafts_used';
-- EXPECT: one row -> free_tool_drafts_used | integer | NO | 0

-- 2. `authenticated` CANNOT write the column. THIS IS THE ONE THAT MATTERS:
--    if it comes back with rows, somebody granted it and the paywall is a
--    formality - a pro could reset their own counter over the REST API.
select privilege_type
  from information_schema.column_privileges
 where table_schema = 'public'
   and table_name = 'contractors'
   and column_name = 'free_tool_drafts_used'
   and grantee in ('authenticated', 'anon')
 order by privilege_type;
-- EXPECT: ZERO rows. Empty is correct here.

-- 3. Both functions exist, are SECURITY INVOKER (prosecdef = f), and pin
--    their search_path.
select p.proname, p.prosecdef, p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('claim_pro_free_taste', 'refund_pro_free_taste')
 order by p.proname;
-- EXPECT: two rows, both with prosecdef = f and {search_path=public}

-- 4. ONLY service_role may execute them.
select routine_name, grantee, privilege_type
  from information_schema.routine_privileges
 where routine_schema = 'public'
   and routine_name in ('claim_pro_free_taste', 'refund_pro_free_taste')
 order by routine_name, grantee;
-- EXPECT: service_role | EXECUTE for each (and postgres, which owns them).
--         NOT anon, NOT authenticated, NOT PUBLIC.

-- 5. Nothing existing was disturbed: every pro starts with a full allowance.
select count(*) as pros, count(*) filter (where free_tool_drafts_used > 0)
         as pros_who_have_spent_one
  from public.contractors;
-- EXPECT: your contractor count, then 0. The second number climbs as
--         non-members try the back office.

-- 6. The claim really is capped. Run this on a throwaway contractor id only
--    (it SPENDS drafts). The third call must come back false.
-- select public.claim_pro_free_taste('<contractor uuid>'::uuid, 2);  -- t
-- select public.claim_pro_free_taste('<contractor uuid>'::uuid, 2);  -- t
-- select public.claim_pro_free_taste('<contractor uuid>'::uuid, 2);  -- f
-- select public.refund_pro_free_taste('<contractor uuid>'::uuid);
