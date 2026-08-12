-- =============================================================================
-- Hearth - one-time win-back credit for inactive pros
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- The daily win-back cron (src/app/api/cron/pro-winback) finds pros who never
-- got going (onboarded 14+ days with no application ever, or an empty wallet
-- and no application in 30+ days) and calls grant_winback_credit() to put $15
-- (1500 cents) of expiring bonus credit in their wallet, enough to cover most
-- of a first application fee, gone in 14 days if unused.
--
-- ONE grant per contractor, EVER: the ledger is the guard. If the wallet
-- already has any 'winback_credit' transaction, the call is a no-op that
-- returns false, so cron re-runs, overlapping runs, and future eligibility
-- (e.g. going quiet again next year) can never double-grant.
--
-- ELIGIBILITY LIVES HERE, not in the route (0028 doctrine: every rule that
-- gates money is re-checked atomically inside the function, after the lock).
-- The cron's scan is only a cheap pre-filter; its bulk reads can be silently
-- truncated by the PostgREST row cap, so nothing it computed is trusted.
--
-- Safe to re-run.
-- =============================================================================

-- Grant the one-time win-back credit as expiring bonus.
-- Returns true iff it granted; false for an unknown contractor, a wallet that
-- already received it, or a contractor who is not actually eligible. Called
-- only by the daily cron (service role).
create or replace function public.grant_winback_credit(p_contractor uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_created timestamptz;
  v_wallet uuid;
  v_cash bigint;
  v_bonus bigint;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  if p_contractor is null then return false; end if;
  select created_at into v_created from contractors where id = p_contractor;
  if v_created is null then return false; end if;

  v_wallet := get_or_create_wallet(p_contractor);

  -- Serialize concurrent calls for the same wallet: two overlapping cron runs
  -- both reach the guard below, and without this lock both could pass it. The
  -- second waits here, then sees the first's ledger row (same as 0034).
  -- Locking and reading the balances in one statement means the eligibility
  -- check below runs against post-lock values, never a stale snapshot.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;

  -- Idempotency guard: once per contractor, ever. Any prior win-back row on
  -- this wallet, whatever its note says, means the credit was already given.
  if exists (
    select 1 from wallet_transactions
    where wallet_id = v_wallet and type = 'winback_credit'
  ) then
    return false;
  end if;

  -- Eligibility, verified in-DB after the lock. Two ways in:
  --   (a) never got going: onboarded 14+ days ago and zero applications ever
  --   (b) broke and quiet: wallet at exactly zero (cash and bonus), no
  --       application in the last 30 days, and onboarded 30+ days ago, so a
  --       brand-new signup with an (obviously) empty wallet does not qualify
  --       on day one.
  if not (
    (
      v_created <= now() - interval '14 days'
      and not exists (
        select 1 from lead_applications la
        where la.contractor_id = p_contractor
      )
    )
    or (
      coalesce(v_cash, 0) + coalesce(v_bonus, 0) = 0
      and v_created <= now() - interval '30 days'
      and not exists (
        select 1 from lead_applications la
        where la.contractor_id = p_contractor
          and la.created_at > now() - interval '30 days'
      )
    )
  ) then
    return false;
  end if;

  -- Granted bonus behaves like bonus everywhere else: a tranche that expires
  -- (drawn FIFO by the spend paths) plus the wallet counter plus a ledger row.
  insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
    values (v_wallet, 1500, 1500, now() + interval '14 days');

  update wallets
     set bonus_balance_cents = bonus_balance_cents + 1500,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  insert into wallet_transactions
    (wallet_id, type, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'winback_credit', 1500,
            v_cash_after, v_bonus_after, 'One-time win-back credit');

  return true;
end; $$;

-- Cron-only entry point: no auth.uid() check inside, so client roles must
-- never be able to call it (same treatment as apply_deposit in 0019).
revoke all on function public.grant_winback_credit(uuid) from public;
revoke all on function public.grant_winback_credit(uuid) from anon;
revoke all on function public.grant_winback_credit(uuid) from authenticated;
grant execute on function public.grant_winback_credit(uuid) to service_role;
