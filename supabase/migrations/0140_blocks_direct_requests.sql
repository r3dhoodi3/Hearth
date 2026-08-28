-- =============================================================================
-- Hearth - close the block gap on direct requests, and two small hardenings
-- on public.user_blocks
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor), AFTER 0139.
--
-- WHY THIS EXISTS
--
-- 1. UNLOCK_DIRECT_REQUEST NEVER LEARNED ABOUT BLOCKS. 0138 gated the two
--    other places a pro spends wallet money against a homeowner they have a
--    block with: apply_to_lead() (its own header, Part 5) and the job board
--    (open_jobs_for_me(), Part 4). unlock_direct_request() - the third and
--    last spending path, 0105/0115's paid unlock of a direct request - was
--    left untouched. A pro who still holds (or is handed, or guesses) a
--    direct-request lead id can pay to unlock it against a homeowner who has
--    blocked them, or whom they blocked, and the assignment UPDATE at the end
--    of that function sets contractor_id - which is exactly the column
--    lead_has_block() and the messages insert policy use to find the other
--    party on the thread. The pro would hold a paid, assigned job and then be
--    unable to send the first message, with no way to get the money back
--    short of support.
--
-- 2. THE TWO GAPS BELOW ARE UNRELATED TO 1 AND EXIST SO A RE-RUN CAN'T QUIETLY
--    SKIP THEM.
--    a. public.user_blocks.reason has no length limit. Every other free-text
--       column a signed-in account can write in this schema is capped
--       (contractors.about at 1,000, reports presumably next); an unbounded
--       reason is the one column here that is not.
--    b. 0138 added the pair-uniqueness rule as an INLINE `unique (...)`
--       inside `create table if not exists public.user_blocks`. That is fine
--       the first time the table is created, but it means the constraint's
--       existence rides on that CREATE TABLE statement having actually run -
--       on a database where user_blocks already exists from an earlier
--       partial paste, the whole CREATE TABLE IF NOT EXISTS is a no-op and
--       nothing re-checks that the unique constraint is there. Naming it and
--       using the drop-if-exists/add pattern this file already uses for
--       user_blocks_reason_len (and 0138 already uses for
--       user_blocks_not_self) makes its presence independent of whether the
--       CREATE TABLE ever ran.
--
-- WHAT THIS FILE DOES, in order:
--   1. unlock_direct_request() - 0132's body, byte for byte, plus ONE gate:
--      the same blocked_between() check apply_to_lead already carries,
--      placed in the equivalent spot - after the lead is locked and every
--      "is this even open" check has passed, and before the wallet is
--      touched, before a single cent moves, before any row is written.
--   2. public.user_blocks.reason gets a 500-character CHECK constraint.
--   3. public.user_blocks' pair-uniqueness rule is re-issued under a real
--      name, user_blocks_pair_uniq, via drop-if-exists/add.
--
-- WHAT DOES NOT CHANGE: no column is dropped, no row is rewritten, no price
-- moves, and the one function re-issued below is a copy of its latest
-- definition (0132) with the named lines added and nothing else edited. The
-- signature is unchanged, so CREATE OR REPLACE preserves the existing
-- EXECUTE grant (0132 restated no explicit grant for unlock_direct_request,
-- so it stands on the default PUBLIC/authenticated EXECUTE it has always had -
-- this file does not add one either, for the same reason 0132 didn't).
--
-- IF THIS FILE HAS NOT BEEN RUN ON LIVE YET: nothing new breaks. A blocked
-- pro can still pay to unlock a direct request against a homeowner they have
-- a block with, exactly as they could before 0138. apply_to_lead, the job
-- board and messaging are unaffected either way.
--
-- Idempotent: the function is CREATE OR REPLACE, both constraints are
-- drop-then-add by name. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: unlock_direct_request - 0132's body, plus the block gate
-- =============================================================================
-- COPY-ONLY, the same discipline 0138 used for open_jobs_for_me and
-- apply_to_lead. 0132 is the latest definition of unlock_direct_request in
-- this folder (0105 created it, 0115 re-issued it for the intro price, 0132
-- added the chargeback freeze, nothing since). ONE block added and nothing
-- else edited.
--
-- WHERE THE GATE SITS: immediately after the lead is locked and read (so
-- v_direct_to, v_lead_contractor, v_status etc. are all resolved) and after
-- every existing "is this request even available" check - not a direct
-- request, not mine, already assigned, declined, not new - and still before
-- get_or_create_wallet, the wallet FOR UPDATE, the bonus drain, the debit,
-- and the final assignment UPDATE that sets contractor_id and opens the chat.
-- Nothing between the last existing check and this gate mutates anything, so
-- placing it here costs nothing extra and still refuses before a single cent
-- moves.
--
-- The property owner is resolved through a join inside the predicate rather
-- than read into a local variable first. property_id on contractor_leads can
-- in principle be null, and a join simply matches zero rows in that case (no
-- block found), so a null property never needs its own null-check the way a
-- bare variable comparison would.
--
-- Worded exactly like apply_to_lead's gate, and for the same reason: a pro
-- must not be able to use the error message to learn WHICH side blocked whom.
create or replace function public.unlock_direct_request(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_direct_to uuid; v_lead_contractor uuid; v_status text; v_category text;
  v_declined timestamptz; v_unlocked timestamptz; v_price bigint;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  -- Privileged flag: the contractor_leads_locked trigger (0077, latest body
  -- 0088) strips any client write to contractor_id/paid/paid_at/status unless
  -- this session flag is set, exactly as apply_to_lead/choose_applicant do
  -- (0087). Without it, the final assignment UPDATE below would be silently
  -- reverted after the wallet was already debited. Must be the FIRST statement.
  perform set_config('hearth.lead_write', 'on', true);

  select id into v_contractor from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- 0132: an open payment dispute freezes spending. has_open_chargeback() is
  -- true only while this pro's account carries an uncleared abuse_flags row of
  -- kind 'chargeback' (written by the Stripe webhook on
  -- charge.dispute.created). Placed here, immediately after the contractor
  -- resolves and BEFORE the job is read, before any wallet lock, and before a
  -- single cent moves: a pro who has charged back a wallet top-up is spending
  -- money the platform has already lost, and the wallet balance still says it
  -- is there. Cleared by setting abuse_flags.cleared_at (service role only), so
  -- a dispute that is won or withdrawn unfreezes the account without erasing
  -- that it happened.
  if public.has_open_chargeback(v_contractor) then
    raise exception 'There is an unresolved payment dispute on your account. Contact support.';
  end if;

  -- Lock the lead and price the fee from its age, same as apply_to_lead.
  -- 0113: category is read too, so the intro price below can tell whether
  -- this is a major-tier request.
  select direct_to, contractor_id, status, category,
         direct_declined_at, direct_unlocked_at,
         public.lead_fee_cents(payout_amount, created_at)
    into v_direct_to, v_lead_contractor, v_status, v_category,
         v_declined, v_unlocked, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_direct_to is null then raise exception 'Not a direct request'; end if;
  if v_direct_to <> v_contractor then raise exception 'Not your request'; end if;

  -- Already unlocked: by me -> idempotent success; otherwise impossible.
  if v_lead_contractor is not null then
    if v_lead_contractor = v_contractor then return true; end if;
    raise exception 'Request already assigned';
  end if;
  if v_declined is not null then raise exception 'Request was declined'; end if;
  if v_status <> 'new' then raise exception 'Request no longer available'; end if;

  -- 0140: a block between these two people. Same predicate as apply_to_lead's
  -- gate (0138), same wording, same reason: symmetric, and it must not tell
  -- the pro which side blocked whom. This is the third and last place a pro
  -- spends wallet money - the job board (open_jobs_for_me) and apply_to_lead
  -- were closed in 0138; this was the one left open. Placed after every
  -- existing "is this request even available" check and before
  -- get_or_create_wallet, so it costs nothing extra and still refuses before
  -- any wallet is touched.
  if exists (
    select 1
    from contractor_leads l
    join properties pr on pr.id = l.property_id
    where l.id = p_lead
      and public.blocked_between(auth.uid(), pr.user_id)
  ) then
    raise exception 'This job is not available to you.';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065/0087 hardening: FOR UPDATE so a concurrent charge against this same
  -- wallet (a different lead, an apply, a ghost recharge) can't read a stale
  -- balance and push cash/bonus negative.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price, after the wallet lock for the
  -- same serialization reason as apply_to_lead (see 0113's header).
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail after the
  -- lead was already treated as unlockable (0087).
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: prompt a deposit
  end if;

  select spend_cash_first into v_cash_first from wallet_config where id = 1;
  if v_cash_first then
    v_from_cash := least(v_cash, v_price);
    v_from_bonus := v_price - v_from_cash;
  else
    v_from_bonus := least(v_bonus_avail, v_price);
    v_from_cash := v_price - v_from_bonus;
  end if;

  if v_from_bonus > 0 then
    v_remaining := v_from_bonus;
    for v_grant in
      select * from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now()
      order by expires_at asc, created_at asc
    loop
      exit when v_remaining <= 0;
      if v_grant.remaining_cents >= v_remaining then
        update bonus_grants set remaining_cents = remaining_cents - v_remaining
         where id = v_grant.id;
        v_remaining := 0;
      else
        v_remaining := v_remaining - v_grant.remaining_cents;
        update bonus_grants set remaining_cents = 0 where id = v_grant.id;
      end if;
    end loop;
    if v_remaining > 0 then return false; end if;  -- safety
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- History row for the paid unlock (also the row ghost_refund_direct marks).
  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, null, 'chosen', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'direct_unlock', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Direct request unlocked');

  -- Assign + open chat: contractor_id set is what unlocks contact and messages.
  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now(), direct_unlocked_at = now()
   where id = p_lead;

  return true;
end; $$;

comment on function public.unlock_direct_request(uuid) is
  'Pays to unlock and assign a direct request (0105/0115). Copy of 0132''s '
  'body plus one gate (0140): refuses when public.blocked_between() is true '
  'between the caller and the request''s property owner, placed after every '
  'availability check and before the wallet is touched. Closes the same gap '
  '0138 already closed on open_jobs_for_me and apply_to_lead - this was the '
  'third spending path and the one left open.';


-- =============================================================================
-- Part 2: public.user_blocks.reason gets a length cap
-- =============================================================================
alter table public.user_blocks drop constraint if exists user_blocks_reason_len;
alter table public.user_blocks
  add constraint user_blocks_reason_len
  check (reason is null or char_length(reason) <= 500);


-- =============================================================================
-- Part 3: name the pair-uniqueness constraint on public.user_blocks
-- =============================================================================
-- 0138 added this rule as an inline `unique (blocker_user_id, blocked_user_id)`
-- inside `create table if not exists public.user_blocks`, so its presence
-- depends on that CREATE TABLE statement having actually executed. Re-issuing
-- it here by name, with the drop-if-exists/add pattern 0138 already uses for
-- user_blocks_not_self two lines below it, makes the rule's presence
-- independent of that - a partial re-run of 0138 that skipped the CREATE
-- TABLE (because the table already existed) cannot leave this rule missing.
--
-- The first DROP targets Postgres' own default name for an inline table-level
-- UNIQUE (table_col1_col2_key); the second is a no-op the first time this
-- file runs and guards every re-run after. Either the default-named
-- constraint or this one may be present depending on history - dropping both
-- before adding leaves exactly one, correctly named, either way.
alter table public.user_blocks
  drop constraint if exists user_blocks_blocker_user_id_blocked_user_id_key;
alter table public.user_blocks
  drop constraint if exists user_blocks_pair_uniq;
alter table public.user_blocks
  add constraint user_blocks_pair_uniq
  unique (blocker_user_id, blocked_user_id);


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. Diff Part 1 against 0132's unlock_direct_request: the ONLY difference
--    should be the one block marked "0140", placed after the 'Request no
--    longer available' check and before `v_wallet := get_or_create_wallet`.
--    The signature is unchanged, so CREATE OR REPLACE keeps the function's
--    existing EXECUTE grant.
--
-- 2. Dry run, on a copy: as the pro who is D0's direct_to on a fresh direct
--    request, with a block row between the caller and the property owner
--    (insert into user_blocks (blocker_user_id, blocked_user_id) values
--    (...)), select public.unlock_direct_request('<lead>') must raise 'This
--    job is not available to you.' and must not touch wallets,
--    lead_applications, wallet_transactions or contractor_leads. Delete the
--    block row and the same call must proceed to its normal chargeback/price/
--    balance logic.
--
-- 3. A direct request with NO block in place is unaffected: confirm a normal
--    unlock still succeeds end to end (wallet debited, lead_applications row
--    inserted with status 'chosen', contractor_leads assigned) exactly as it
--    did before this file.
--
-- 4. user_blocks_reason_len: a reason over 500 characters is refused; 500 or
--    fewer, or null, succeeds. Confirm with:
--      select conname from pg_constraint
--       where conrelid = 'public.user_blocks'::regclass
--         and conname = 'user_blocks_reason_len';
--
-- 5. user_blocks_pair_uniq: confirm exactly one unique constraint remains on
--    (blocker_user_id, blocked_user_id), named user_blocks_pair_uniq, and
--    that inserting the same pair twice still raises 23505:
--      select conname, contype
--        from pg_constraint
--       where conrelid = 'public.user_blocks'::regclass
--         and contype = 'u';
-- =============================================================================
