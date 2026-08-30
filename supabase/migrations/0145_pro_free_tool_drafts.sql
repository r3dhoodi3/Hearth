-- =============================================================================
-- Hearth - free tastes for the pro AI back office
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- The AI back office (/pro/tools and /api/pro-tools: estimate, invoice,
-- follow-up, review response, overdue reminder) was members-only, full stop.
-- A pro who had never seen a draft was asked to pay for the idea of one. This
-- gives every contractor account a small lifetime taste first, then the wall -
-- the same shape as the homeowner side's one free quote check (0030), one free
-- plan build (0101) and the document/inspection tastes (0135).
--
--   contractors.free_tool_drafts_used   lifetime back-office drafts a
--                                       non-member contractor has spent. The
--                                       limit lives in the app
--                                       (FREE_PRO_DRAFTS in
--                                       src/lib/freeAiTaste.ts).
--
-- Pro members never touch this counter: they stay bounded by the existing
-- daily/burst/global ceilings in src/lib/aiUsage.ts.
--
-- WHY A COLUMN ON contractors AND NOT users. The taste belongs to the
-- BUSINESS, which is what has a membership and a wallet, and a business is
-- what the tools write paperwork for. It also lands on the safer table:
-- migration 0085 revoked table-level INSERT/UPDATE on public.contractors from
-- authenticated and anon and re-granted a hard-coded column allowlist, so a
-- column added now is unwritable by a signed-in account by construction. NO
-- GRANT IS ADDED FOR IT BELOW, deliberately - that omission is the lock. (The
-- equivalent counters on public.users needed migration 0139's guard trigger to
-- get the same property.)
--
-- Defaults, not a data rewrite: `default 0 not null` on an added column is a
-- metadata-only change in Postgres 11+, so no table is rewritten and every
-- existing row reads as 0 (nothing spent) without an UPDATE pass.
--
-- Safe to re-run.
-- =============================================================================

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
