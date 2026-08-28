-- =============================================================================
-- Hearth - free tastes for the two unmetered AI reads
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Two features called the paid model for free accounts with no per-feature
-- limit at all, only the shared 25/day tool ceiling: the document vault's AI
-- read (/api/extract-document) and the inspection report import
-- (/api/ingest-inspection). Both now get a lifetime taste, the same shape as
-- the one free quote check (users.free_quote_used_at, migration 0030) and the
-- one free maintenance-plan build (users.free_plan_used_at, migration 0101),
-- except these are COUNTS rather than a single timestamp because the document
-- taste is two reads, not one.
--
--   free_doc_reads_used         lifetime AI document reads a free account has
--                               spent. Limit lives in the app
--                               (FREE_DOC_READS in src/lib/freeAiTaste.ts).
--   free_inspection_reads_used  same, for inspection report imports.
--
-- Plus (and trialing) accounts never touch either counter: they stay bounded
-- by the existing daily/burst/global ceilings in src/lib/aiUsage.ts.
--
-- GRANTS / WHO MAY WRITE THESE. Reading is covered by the "users self select"
-- policy (migration 0002), exactly like free_quote_used_at. WRITING is NOT:
-- "users self update" is row-scoped and names no columns, so before migration
-- 0139 a signed-in account could PATCH /rest/v1/users?id=eq.<self> and reset
-- its own counters, which would have made this whole paywall a formality. The
-- two functions below are the only writers the app uses, and 0139 adds the
-- BEFORE UPDATE guard trigger on public.users that makes that true at the
-- database level as well. Run 0139 with (or before) this file.
--
-- Defaults, not a data rewrite: `default 0 not null` on an added column is a
-- metadata-only change in Postgres 11+, so no table is rewritten and every
-- existing row reads as 0 (nothing spent) without an UPDATE pass.
--
-- Safe to re-run.
-- =============================================================================

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
