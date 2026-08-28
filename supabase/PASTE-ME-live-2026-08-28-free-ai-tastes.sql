-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0135 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0133 (or 0134) before this. After running, live is
-- at 0135.
--
-- WHAT THIS IS: two counter columns on public.users plus the two service-role
-- functions that move them, so the document vault's AI read and the
-- inspection report import stop being free-and-unlimited on the paid model.
-- Free accounts get a lifetime taste (2 document reads, 1 inspection import);
-- Plus and trialing accounts are unaffected and stay bounded by the existing
-- daily ceilings in src/lib/aiUsage.ts.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/lib/freeAiTaste.ts FAILS OPEN on a
-- missing column or a missing function: it logs and lets the read through,
-- which is exactly today's behaviour. The meter simply does not appear and no
-- free account is ever told it spent something the database cannot prove it
-- spent. The generic per-user daily cap, the burst window, and the owner-wide
-- spend breakers all still apply in the meantime.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0135_free_ai_tastes.sql >>>>>>>>>>

alter table public.users
  add column if not exists free_doc_reads_used integer not null default 0;

alter table public.users
  add column if not exists free_inspection_reads_used integer not null default 0;

comment on column public.users.free_doc_reads_used is
  'Lifetime document-vault AI reads a non-Plus account has spent. Claimed by claim_free_ai_taste, handed back by refund_free_ai_taste when the model call fails.';

comment on column public.users.free_inspection_reads_used is
  'Lifetime inspection-report imports a non-Plus account has spent. Same pair of functions as free_doc_reads_used.';

-- Claim one taste, ATOMICALLY.
--
-- WHY A FUNCTION. supabase-js sends literal values in an update, so it cannot
-- express `col = col + 1`; a read-then-write from the app would let two
-- parallel requests both pass the same check and each spend a taste that was
-- never there. This does the read and the write in one statement, with the
-- limit in the WHERE clause, so exactly p_limit claims can ever succeed no
-- matter how many requests arrive at once. That is the same guarantee the
-- quote analyzer gets from its conditional `is null` update
-- (src/app/api/analyze-quote/route.ts).
--
-- Returns true when this caller got a taste, false when they are out (or the
-- feature name is unknown, or the row is missing). The app treats false as the
-- paywall.
--
-- INVOKER, deliberately (no `security definer` line - invoker is Postgres's
-- default). EXECUTE is granted to service_role ONLY, the same trusted-server
-- posture as linked_accounts (0130) and claim_promo (0073), and Supabase's
-- service_role already carries BYPASSRLS - so the only role that can call this
-- function already sees past "users self update" without any help. Definer
-- would therefore add no capability at all, while turning a future copy-paste
-- mistake (one stray `grant execute ... to authenticated`) from a permission
-- error into a privilege escalation on public.users. The atomicity that
-- actually matters here comes from the single conditional UPDATE below, not
-- from the definer bit. `set search_path = public` stays either way: it pins
-- the schema this body resolves against no matter who calls it. Postgres
-- grants EXECUTE on a new function to PUBLIC, so that grant is revoked
-- explicitly.
create or replace function public.claim_free_ai_taste(
  p_user uuid,
  p_feature text,
  p_limit integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_user is null or p_limit is null or p_limit <= 0 then
    return false;
  end if;

  -- A CASE over two known names rather than dynamic SQL: the feature list is
  -- fixed, and there is no string ever interpolated into a statement here.
  if p_feature = 'document' then
    update public.users
       set free_doc_reads_used = coalesce(free_doc_reads_used, 0) + 1
     where id = p_user
       and coalesce(free_doc_reads_used, 0) < p_limit;
  elsif p_feature = 'inspection' then
    update public.users
       set free_inspection_reads_used = coalesce(free_inspection_reads_used, 0) + 1
     where id = p_user
       and coalesce(free_inspection_reads_used, 0) < p_limit;
  else
    return false;
  end if;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.claim_free_ai_taste(uuid, text, integer) is
  'Atomically spend one free AI taste for p_user on p_feature (document | inspection) while under p_limit. True when claimed. Service role only.';

-- The grant is the LAST thing said about this function, deliberately: whoever
-- reads or edits this block should see the full role list with nothing after
-- it that could be mistaken for a second grant.
revoke all on function public.claim_free_ai_taste(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_free_ai_taste(uuid, text, integer)
  to service_role;

-- Hand a claimed taste back when the model call never produced a result: a
-- blurry photo, a thrown request, a ceiling above the caller. Same thinking as
-- refundAskUsage / refundAiUsage in src/lib/aiUsage.ts, which is why the app
-- claims up front (race-proof) and refunds on failure rather than counting
-- afterwards. Never drives a counter below zero.
--
-- INVOKER for the same reason as claim_free_ai_taste above: service_role is
-- the only role granted EXECUTE, and it already bypasses RLS.
create or replace function public.refund_free_ai_taste(
  p_user uuid,
  p_feature text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_user is null then
    return;
  end if;

  if p_feature = 'document' then
    update public.users
       set free_doc_reads_used = greatest(coalesce(free_doc_reads_used, 0) - 1, 0)
     where id = p_user;
  elsif p_feature = 'inspection' then
    update public.users
       set free_inspection_reads_used =
             greatest(coalesce(free_inspection_reads_used, 0) - 1, 0)
     where id = p_user;
  end if;
end;
$$;

comment on function public.refund_free_ai_taste(uuid, text) is
  'Hand back one free AI taste for p_user on p_feature after a failed model call. Never goes below zero. Service role only.';

-- Grant last, same reasoning as claim_free_ai_taste above.
revoke all on function public.refund_free_ai_taste(uuid, text)
  from public, anon, authenticated;
grant execute on function public.refund_free_ai_taste(uuid, text)
  to service_role;

-- <<<<<<<<<< END 0135_free_ai_tastes.sql <<<<<<<<<<

-- Verify 1, the columns exist with the right defaults (should return two
-- rows: free_doc_reads_used | integer | 0 | NO, and
-- free_inspection_reads_used | integer | 0 | NO):
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'users'
--      and column_name in ('free_doc_reads_used', 'free_inspection_reads_used')
--    order by column_name;
--
-- Verify 2, no existing row was left null and nobody was retroactively
-- charged a taste (should return one row: 0 | 0 | 0):
--   select count(*) filter (where free_doc_reads_used is null
--                              or free_inspection_reads_used is null) as nulls,
--          count(*) filter (where free_doc_reads_used > 0) as docs_spent,
--          count(*) filter (where free_inspection_reads_used > 0) as inspections_spent
--     from public.users;
--
-- Verify 3, both functions exist and are service_role only (should return two
-- rows, each with acl showing service_role=X and NOTHING for anon,
-- authenticated, or PUBLIC, and security_definer = f on both - these two are
-- SECURITY INVOKER on purpose, see the comment above claim_free_ai_taste):
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args,
--          p.prosecdef as security_definer, p.proacl::text as acl
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('claim_free_ai_taste', 'refund_free_ai_taste')
--    order by p.proname;
--
-- Verify 4, the claim is really capped (run against YOUR OWN user id, then
-- put it back). With the app limit of 2 for documents, the first two calls
-- return true and the third returns false:
--   select public.claim_free_ai_taste('<your-user-id>'::uuid, 'document', 2);
--   select public.claim_free_ai_taste('<your-user-id>'::uuid, 'document', 2);
--   select public.claim_free_ai_taste('<your-user-id>'::uuid, 'document', 2);  -- false
--   select public.refund_free_ai_taste('<your-user-id>'::uuid, 'document');
--   select public.refund_free_ai_taste('<your-user-id>'::uuid, 'document');
--   select free_doc_reads_used from public.users where id = '<your-user-id>';  -- back to 0
