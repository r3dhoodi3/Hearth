-- =============================================================================
-- Hearth - first application guaranteed
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- A new pro's FIRST EVER application, if they are not chosen for the job, gets
-- 100% of the apply fee back automatically as expiring bonus credit (NOT cash):
-- a fresh bonus_grants tranche that expires in 60 days. Once per contractor,
-- EVER, and only for pros with a license number on file whose verification
-- has not FAILED (0037). The point: the pay-before-proof barrier goes away
-- honestly: credit-back costs near zero cash and gives the pro a reason to
-- apply again.
--
-- The daily cron (src/app/api/cron/first-apply-guarantee) finds rough
-- candidates and calls guarantee_refund_first_application() per application.
-- Every eligibility rule is re-checked atomically in here, and the wallet-level
-- ledger guard (any 'first_apply_guarantee' transaction means already paid)
-- sits behind a FOR UPDATE lock on the wallet row, so cron re-runs and
-- overlapping runs can never double-grant.
--
-- IMPORTANT: this function must NOT set lead_applications.refunded_at. That
-- column means "ghost refund" (migration 0028): choose_applicant()'s revival
-- re-charge keys off it, and the applicant-cap and board counts treat refunded
-- rows as freed spots. A guarantee credit is a separate, wallet-only event; the
-- application row stays exactly as it was. choose_applicant() and the ghost
-- protection functions are untouched by this migration.
--
-- Safe to re-run.
-- =============================================================================

-- Credit back a losing first application as expiring bonus. Returns true iff
-- it granted. Called only by the daily cron (service role).
create or replace function public.guarantee_refund_first_application(p_application uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid;
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
revoke all on function public.guarantee_refund_first_application(uuid) from public;
revoke all on function public.guarantee_refund_first_application(uuid) from anon;
revoke all on function public.guarantee_refund_first_application(uuid) from authenticated;
grant execute on function public.guarantee_refund_first_application(uuid) to service_role;
