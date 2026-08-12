-- =============================================================================
-- Hearth - security remediation: findings #5, #4, #8 (0084)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- Source: docs/SECURITY_AUDIT_2026-07-19.md. Three targeted fixes, each a
-- CREATE OR REPLACE of an existing function's LATEST live body (verified by
-- grepping every migration for "create or replace function public.<name>" -
-- each of the three names below has exactly one prior definition, so that
-- definition is the latest). Every body below is byte-for-byte identical to
-- its source migration except for the one change called out in that
-- function's own comment block. Grants/permissions are unchanged (restated
-- where the source migration restated them, for standalone re-runnability).
-- Idempotent: CREATE OR REPLACE throughout. Safe to re-run.
--
-- FIX A (finding #5, CRITICAL - broken CCPA account deletion):
--   enforce_contractor_leads_locked() (latest body: 0077_lock_contractor_leads.sql)
--   contractor_leads.contractor_id is ON DELETE SET NULL. Deleting a
--   contractors row fires that FK action as an UPDATE, which runs this
--   trigger. With hearth.lead_write unset, the trigger reverted the NULL
--   (anti-forgery for direct client writes), so the FK still pointed at the
--   row being deleted and the DELETE failed - CCPA erasure aborted for any
--   pro who ever had an assigned lead. Fix: skip the stripping logic when
--   pg_trigger_depth() > 1 (this UPDATE was fired from inside the FK's own
--   trigger, i.e. an RI cascade, not a direct client statement). Direct
--   client writes are always the outermost trigger invocation (depth = 1),
--   so the existing forgery protection for them is untouched.
--
-- FIX B (finding #4, CRITICAL - sybil referral self-dealing):
--   grant_referral_rewards(uuid) (latest body: 0044_pro_referrals.sql)
--   Paid $25 + $25 the instant a referred pro's application/lead reached a
--   winning state, with no check that the referred pro and the job's
--   chooser (the homeowner/property owner) are different people. One
--   reusable homeowner account + rotating contractor pairs could farm
--   $50/cycle at ~$0 real cost. Fix: resolve the referred contractor's
--   user_id and the winning job's owner user_id and skip the grant (no
--   error, just no payout) when they match.
--
-- FIX C (finding #8, CRITICAL - first-apply guarantee sybil-farmable):
--   guarantee_refund_first_application(uuid) (latest body: 0041_first_apply_guarantee.sql)
--   Guarded only once-per-contractor via the wallet ledger, so deleting and
--   rebuilding a contractor/wallet under the same auth account (same hole
--   0075 closed for winback_credit) lets the guarantee be re-claimed. Fix:
--   add a claim_promo(user_id, 'first_apply_guarantee', ref) guard mirroring
--   0075_winback_user_guard.sql's pattern exactly (same claim_promo() call
--   shape, same "skip only when the contractor has no user_id" carve-out).
-- =============================================================================

-- ---- FIX A: enforce_contractor_leads_locked() --------------------------------
create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.lead_write', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if not v_privileged then
      -- Reproduces exactly what postJobAction already sends for a fresh,
      -- unassigned posting. A forged insert (contractor_id pre-set, paid =
      -- true, payout_amount lowballed) is silently corrected instead of
      -- rejected, so the ordinary posting flow sees no behavior change.
      new.contractor_id := null;
      new.paid := false;
      new.paid_at := null;
      new.status := 'new';
      new.payout_amount := public.contractor_lead_base_fee(new.category);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- 0084 fix (finding #5): pg_trigger_depth() > 1 means this UPDATE was
    -- fired from inside another trigger - specifically, the FK's ON DELETE
    -- SET NULL action on contractor_leads.contractor_id when a contractors
    -- row is deleted (0005), which runs as a nested trigger, not a direct
    -- client statement. A direct client write (PostgREST, an RPC body) is
    -- always the outermost trigger invocation, so it is always depth = 1.
    -- Skip the anti-forgery stripping only for that RI-cascade case, so
    -- account deletion (CCPA erase) can null out contractor_id on a pro's
    -- assigned leads instead of having it silently reverted and the FK
    -- delete failing. Direct client writes (depth = 1) are unaffected: the
    -- forgery protection below still applies exactly as before.
    if not v_privileged and pg_trigger_depth() <= 1 then
      if new.contractor_id is distinct from old.contractor_id then
        new.contractor_id := old.contractor_id;
      end if;
      if new.paid is distinct from old.paid then
        new.paid := old.paid;
      end if;
      if new.paid_at is distinct from old.paid_at then
        new.paid_at := old.paid_at;
      end if;
      -- Recompute only when category or payout_amount actually changed, so a
      -- status-only update (the pro's updateLeadStatusAction) never touches
      -- payout_amount - this is what keeps rehire_pro's free ($0) leads from
      -- being corrupted back to a paid tier the next time their status
      -- changes. When it IS one of those two columns changing, recomputing
      -- from category reproduces updateJobAction's own
      -- payout_amount = leadFeeFor(category) and blocks a lowballed forgery.
      if new.category is distinct from old.category
         or new.payout_amount is distinct from old.payout_amount then
        new.payout_amount := public.contractor_lead_base_fee(new.category);
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;
-- No explicit grants to restate: this is a trigger function (invoked by the
-- system, not called directly), and 0077 never granted EXECUTE on it to any
-- role. The trigger `contractor_leads_locked` already points at this
-- function name/signature, so CREATE OR REPLACE takes effect immediately
-- without needing to drop/recreate the trigger.

-- ---- FIX B: grant_referral_rewards(uuid) --------------------------------------
create or replace function public.grant_referral_rewards(p_referred uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_ref record;
  v_referrer uuid;
  v_referred_wallet uuid;
  v_referrer_wallet uuid;
  v_cash_after bigint;
  v_bonus_after bigint;
  v_referred_user uuid;
  v_chooser_user uuid;
  v_property_id uuid;
begin
  -- Attribution must be real: referred_by set, never self, and stamped at
  -- onboarding (within 30 days of the row's creation). The app only writes
  -- referred_by on the creating INSERT, so a later stamp is bogus by
  -- definition and an old row can never be newly attributed for a reward.
  select c.id, c.referred_by, c.created_at, c.referred_attributed_at
    into v_ref
    from contractors c
    where c.id = p_referred
      and c.referred_by is not null
      and c.referred_by <> c.id
      and c.referred_attributed_at is not null
      and c.referred_attributed_at <= c.created_at + interval '30 days';
  if v_ref.id is null then return false; end if;
  v_referrer := v_ref.referred_by;

  -- The referrer must still exist to be paid.
  if not exists (select 1 from contractors c where c.id = v_referrer) then
    return false;
  end if;

  -- Revenue event: the referred pro has WON at least one job. Same terminal
  -- win shapes as 0041's sibling logic reads them: an application the
  -- homeowner chose, or a lead assigned to this contractor and paid.
  if not exists (
    select 1 from lead_applications la
    where la.contractor_id = p_referred and la.status = 'chosen'
  ) and not exists (
    select 1 from contractor_leads cl
    where cl.contractor_id = p_referred and cl.paid = true
  ) then
    return false;
  end if;

  -- 0084 fix (finding #4): sybil self-dealing guard. choose_applicant() is
  -- free and never required the chosen applicant to be a stranger, so one
  -- reusable homeowner account paired with a referred contractor could win
  -- their own posted job and collect the $25+$25 referral reward at ~$0 real
  -- cost. Resolve the referred pro's own user_id and the winning job's
  -- owner (chooser) user_id - checking both win shapes above, chosen
  -- application first, paid lead as the fallback - and skip the reward
  -- (return false, no grant, no error) when they are the same auth user.
  -- A legitimate referral (distinct homeowner) is unaffected.
  select c.user_id into v_referred_user from contractors c where c.id = p_referred;

  select p.user_id, p.id into v_chooser_user, v_property_id
    from lead_applications la
    join contractor_leads cl on cl.id = la.lead_id
    join properties p on p.id = cl.property_id
    where la.contractor_id = p_referred and la.status = 'chosen'
    order by la.created_at asc
    limit 1;

  if v_chooser_user is null then
    select p.user_id, p.id into v_chooser_user, v_property_id
      from contractor_leads cl
      join properties p on p.id = cl.property_id
      where cl.contractor_id = p_referred and cl.paid = true
      order by cl.created_at asc
      limit 1;
  end if;

  -- Self-dealing guard: reject when the referred pro's own auth user could have
  -- been the one who chose them. That is true if they are the property OWNER, or
  -- an ACTIVE HOUSEHOLD MEMBER of the property. owns_property() lets household
  -- members call choose_applicant too, so checking only properties.user_id (the
  -- owner) was bypassable via a household invite.
  if v_referred_user is not null and (
       v_referred_user = v_chooser_user
       or exists (
         select 1 from public.household_members hm
         where hm.property_id = v_property_id
           and hm.member_user_id = v_referred_user
           and hm.status = 'active'
       )
     ) then
    return false;
  end if;

  v_referred_wallet := get_or_create_wallet(p_referred);
  v_referrer_wallet := get_or_create_wallet(v_referrer);

  -- Lock BOTH wallets before reading the ledger guards, always lower uuid
  -- first: two concurrent calls that touch the same pair of wallets in
  -- opposite roles (A refers B while B refers A, or overlapping cron runs)
  -- would deadlock if each locked "its own" wallet first. A single global
  -- lock order (ascending id) makes that impossible; the second caller just
  -- waits, then sees the first caller's ledger rows below.
  if v_referred_wallet < v_referrer_wallet then
    perform 1 from wallets where id = v_referred_wallet for update;
    perform 1 from wallets where id = v_referrer_wallet for update;
  else
    perform 1 from wallets where id = v_referrer_wallet for update;
    perform 1 from wallets where id = v_referred_wallet for update;
  end if;

  -- Once per referred pro, EVER: any prior referral_reward row on the
  -- referred pro's wallet means this referral was already paid out.
  if exists (
    select 1 from wallet_transactions
    where wallet_id = v_referred_wallet and type = 'referral_reward'
  ) then
    return false;
  end if;

  -- Referrer cap: at most 10 rewarded referrals per calendar year. Each
  -- rewarded referral writes exactly one referral_reward row on the
  -- referrer's wallet, so counting this year's rows IS the year's tally.
  if (
    select count(*) from wallet_transactions
    where wallet_id = v_referrer_wallet
      and type = 'referral_reward'
      and created_at >= date_trunc('year', now())
  ) >= 10 then
    return false;
  end if;

  -- $25 of expiring credit to the REFERRED pro: a 90-day bonus tranche
  -- (drawn FIFO by the spend paths), the wallet counter, and a ledger row.
  insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
    values (v_referred_wallet, 2500, 2500, now() + interval '90 days');
  update wallets
     set bonus_balance_cents = bonus_balance_cents + 2500,
         updated_at = now()
   where id = v_referred_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;
  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_referred_wallet, 'referral_reward', 0, 2500,
            v_cash_after, v_bonus_after,
            'Referral bonus: won first job, referred by contractor '
              || v_referrer::text);

  -- And $25 to the REFERRER.
  insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
    values (v_referrer_wallet, 2500, 2500, now() + interval '90 days');
  update wallets
     set bonus_balance_cents = bonus_balance_cents + 2500,
         updated_at = now()
   where id = v_referrer_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;
  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_referrer_wallet, 'referral_reward', 0, 2500,
            v_cash_after, v_bonus_after,
            'Referral bonus: referred contractor ' || p_referred::text
              || ' won their first job');

  return true;
end; $$;

-- Cron-only entry point: no auth.uid() check inside, so client roles must
-- never be able to call it (same treatment as apply_deposit in 0019).
-- Restated for standalone re-runnability (CREATE OR REPLACE does not change
-- grants when the signature is unchanged, and this migration otherwise makes
-- no grant changes).
revoke all on function public.grant_referral_rewards(uuid) from public;
revoke all on function public.grant_referral_rewards(uuid) from anon;
revoke all on function public.grant_referral_rewards(uuid) from authenticated;
grant execute on function public.grant_referral_rewards(uuid) to service_role;

-- ---- FIX C: guarantee_refund_first_application(uuid) --------------------------
create or replace function public.guarantee_refund_first_application(p_application uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid;
  v_user uuid;
  v_app record;
  v_lead record;
  v_wallet uuid;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  -- Resolve the contractor so the wallet can be locked first. This read is
  -- only routing: every money-gating rule is re-verified below AFTER the
  -- locks, against fresh rows (0028 doctrine).
  select la.contractor_id into v_contractor
    from lead_applications la
    where la.id = p_application;
  if v_contractor is null then return false; end if;

  -- 0084 fix (finding #8): resolve the contractor's auth user_id up front for
  -- the claim_promo() identity guard below (mirrors 0075's winback_user_guard
  -- pattern, which resolves user_id at the same point relative to the rest
  -- of the function).
  select user_id into v_user from contractors where id = v_contractor;

  -- (e) License gate: a license number on file (same non-blank test the
  -- public pro page uses in 0033) AND verification has not FAILED.
  -- Self-reported numbers still awaiting a check ('unverified'/'pending' per
  -- 0037) stay eligible; a check that ran and did not confirm does not.
  -- license_verified_status ships in 0037, which is part of the same pending
  -- migration delta as this file; 0041 must never be applied without it.
  if not exists (
    select 1 from contractors c
    where c.id = v_contractor
      and c.license_number is not null
      and btrim(c.license_number) <> ''
      and c.license_verified_status is distinct from 'failed'
  ) then return false; end if;

  v_wallet := get_or_create_wallet(v_contractor);

  -- Serialize concurrent calls for the same wallet: two overlapping cron runs
  -- both reach the guard below, and without this lock both could pass it. The
  -- second waits here, then sees the first's ledger row (same as 0038).
  perform 1 from wallets where id = v_wallet for update;

  -- (f) Once per contractor, EVER: any prior guarantee row on this wallet,
  -- whatever application it was for, means the credit was already given.
  if exists (
    select 1 from wallet_transactions
    where wallet_id = v_wallet and type = 'first_apply_guarantee'
  ) then
    return false;
  end if;

  -- TOCTOU guard: re-SELECT the application FOR UPDATE and re-verify EVERY
  -- rule against the fresh row. choose_applicant() updates this exact row
  -- when the homeowner picks (or declines) an applicant, so this lock
  -- serializes against it: a concurrent pick either committed before we got
  -- the lock (the fresh row shows 'chosen', or the lead shows assigned, and
  -- we bail below) or waits behind us. If Postgres ever detects a deadlock
  -- with choose_applicant's own lock order, one side aborts cleanly and the
  -- cron simply retries next run.
  --
  -- The application itself: paid (c) and never ghost-refunded (d). If ghost
  -- protection already gave this fee back, the pro is whole: granting the
  -- guarantee on top would pay the same fee twice.
  select la.id, la.lead_id, la.contractor_id, la.fee_cents, la.created_at,
         la.status, la.refunded_at
    into v_app
    from lead_applications la
    where la.id = p_application
    for update;
  if v_app.id is null
     or v_app.contractor_id is distinct from v_contractor
     or v_app.refunded_at is not null
     or coalesce(v_app.fee_cents, 0) <= 0
  then return false; end if;

  -- (a) It must STILL be that contractor's FIRST ever application (min
  -- created_at, id as the tiebreak for same-instant rows).
  if exists (
    select 1 from lead_applications la2
    where la2.contractor_id = v_app.contractor_id
      and la2.id <> v_app.id
      and (la2.created_at < v_app.created_at
           or (la2.created_at = v_app.created_at and la2.id < v_app.id))
  ) then return false; end if;

  -- (b) Terminal loss only, read fresh AFTER the application lock so any
  -- choose_applicant that committed while we waited is visible here. Never
  -- pay a winner: 'chosen' status or the lead assigned to this same
  -- contractor means they got the job.
  select cl.contractor_id, cl.status, cl.created_at into v_lead
    from contractor_leads cl where cl.id = v_app.lead_id;
  if v_app.status = 'chosen'
     or (v_lead.contractor_id is not null
         and v_lead.contractor_id = v_app.contractor_id) then
    return false;
  end if;
  if not (
    -- The homeowner explicitly declined them (choose_applicant marks the
    -- non-chosen applicants 'declined'), or ...
    v_app.status = 'declined'
    -- ... the lead went to a DIFFERENT contractor, or ...
    or (v_lead.contractor_id is not null
        and v_lead.contractor_id <> v_app.contractor_id)
    -- ... the lead left 'new' (closed, expired, withdrawn: v_lead.status is
    -- null when the lead row is gone entirely) without this pro being
    -- chosen, or ...
    or v_lead.status is distinct from 'new'
    -- ... the job is dead but engaged: 30+ days old, still unassigned, still
    -- 'new'. A homeowner message blocks ghost protection (0028) on exactly
    -- these leads, so without this arm a first application on them would
    -- never resolve and the guarantee would silently under-grant.
    or (v_lead.contractor_id is null
        and v_lead.status = 'new'
        and v_lead.created_at <= now() - interval '30 days')
  ) then return false; end if;

  -- ACCEPTED EDGE: a homeowner can revive a DECLINED application days AFTER
  -- this payout (choose_applicant() takes any application id, whatever its
  -- status). That pro then holds both the credit and the job, and nothing
  -- claws the credit back. Accepted deliberately: it is bounded to once-ever
  -- per contractor and paid as expiring bonus credit, never cash.

  -- 0084 fix (finding #8): once per USER, ever, on top of the once-per-wallet
  -- guard above. Mirrors 0075_winback_user_guard.sql's exact pattern: a
  -- contractor/wallet can be deleted and rebuilt under the same auth account
  -- (0010's cascade), which would otherwise reset the wallet-ledger guard
  -- above and let the guarantee be re-claimed. claim_promo() inserts
  -- (user_id, 'first_apply_guarantee') and atomically reports whether it was
  -- new; false here means this account already collected the guarantee under
  -- some contractor row, so grant nothing even though this particular
  -- wallet's own ledger is clean. Skipped only when the contractor has no
  -- user_id (a deleted-user orphan, per 0005's "on delete set null") - there
  -- is no account to key on or to rebuild, so the wallet-only guard above is
  -- unchanged for that case, same treatment as 0075.
  if v_user is not null
     and not coalesce(claim_promo(v_user, 'first_apply_guarantee', p_application::text), false)
  then
    return false;
  end if;

  -- Granted bonus behaves like bonus everywhere else: an expiring tranche
  -- (drawn FIFO by the spend paths) plus the wallet counter plus a ledger row.
  insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
    values (v_wallet, v_app.fee_cents, v_app.fee_cents, now() + interval '60 days');

  update wallets
     set bonus_balance_cents = bonus_balance_cents + v_app.fee_cents,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'first_apply_guarantee', 0, v_app.fee_cents,
            v_cash_after, v_bonus_after, v_app.lead_id,
            'First application guarantee: fee returned as credit');

  -- Deliberately NOT touching lead_applications.refunded_at here: that flag
  -- belongs to ghost protection (0028) and choose_applicant's revival
  -- re-charge depends on it meaning exactly "the fee was refunded".

  return true;
end; $$;

-- Cron-only entry point: no auth.uid() check inside, so client roles must
-- never be able to call it (same treatment as apply_deposit in 0019).
-- Restated for standalone re-runnability (CREATE OR REPLACE does not change
-- grants when the signature is unchanged, and this migration otherwise makes
-- no grant changes).
revoke all on function public.guarantee_refund_first_application(uuid) from public;
revoke all on function public.guarantee_refund_first_application(uuid) from anon;
revoke all on function public.guarantee_refund_first_application(uuid) from authenticated;
grant execute on function public.guarantee_refund_first_application(uuid) to service_role;

-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. FIX A depends on pg_trigger_depth() actually reading > 1 during the FK's
--    ON DELETE SET NULL cascade on live Postgres/Supabase. This is standard
--    Postgres RI-trigger behavior (the FK action itself runs as an internal
--    trigger, and the UPDATE it performs is a nested trigger invocation), but
--    was reasoned about, not executed against a database (per instructions).
--    Dry-run: delete a contractors row that has a contractor_leads row
--    pointing at it and confirm the DELETE now succeeds and contractor_id
--    goes to NULL on the orphaned lead, then separately confirm a direct
--    client UPDATE attempting to forge contractor_id/paid/paid_at is still
--    reverted (depth = 1 path unchanged).
--
-- 2. FIX B's self-dealing check only has data to compare when a win event
--    already exists (it runs after the existing win-check block returns
--    false for "no win yet"), so it changes behavior only for the fraud
--    case: same auth user as both the referred pro and the job's owner.
--    Legitimate referrals (distinct homeowner) see no behavior change.
--
-- 3. FIX C's claim_promo ref uses p_application (this function's own input
--    parameter), the direct analog of 0075 using p_contractor (that
--    function's own input parameter) as the ref - both identify "the thing
--    that triggered this specific grant attempt," not the wallet or user.
--
-- 4. This migration was written and reasoned about, but NOT executed against
--    any database (per instructions). Dry-run against a staging copy of the
--    live schema before applying to production, per this file's own header.
-- =============================================================================
