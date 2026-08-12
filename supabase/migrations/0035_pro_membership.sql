-- =============================================================================
-- Hearth - Pro membership (0032)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Contractor-side "Hearth Pro" membership. NO schema change is needed: the
-- existing public.subscriptions table (0022) keys one row per user and stores
-- the plan as free text, so the new contractor plans ("pro_monthly" /
-- "pro_yearly") ride on the same column next to the homeowner plans
-- ("monthly" / "yearly"). Membership is perks only: it never gates lead
-- access, every pro sees and can apply to every job, member or not.
--
-- The one perk with database teeth: Pro members earn extra percentage points
-- on the deposit bonus. apply_deposit gains an optional p_bonus_boost_pts
-- (default 0) that is added to the matched tier's percentage (0 if the
-- deposit is below every tier) before the bonus cents are computed. A call
-- without the new argument behaves exactly like the current function. The old
-- two-argument overload is dropped first so the existing webhook call stays
-- unambiguous.
--
-- Safe to re-run.
-- =============================================================================

-- Replacing the signature: without this drop, the defaulted third parameter
-- would leave two overloads and make the two-argument call ambiguous.
drop function if exists public.apply_deposit(uuid, bigint);

-- Apply a successful deposit: credit cash, grant bonus, create grant + ledger.
-- Called by the Stripe webhook (service role). p_bonus_boost_pts is the Pro
-- membership boost; 0 (the default) reproduces the pre-0032 behavior bit for
-- bit, including no bonus at all below the entry tier.
create or replace function public.apply_deposit(
  p_contractor uuid,
  p_deposit_cents bigint,
  p_bonus_boost_pts int default 0
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_wallet uuid;
  v_pct bigint;
  v_bonus bigint;
  v_days int;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  v_wallet := get_or_create_wallet(p_contractor);

  -- Matched tier percentage (0 when the deposit is below every tier), plus
  -- the caller-supplied boost points. With boost 0 this equals
  -- bonus_for_deposit(p_deposit_cents) exactly.
  select coalesce((
    select bonus_pct
    from deposit_tiers
    where p_deposit_cents >= min_cents
      and (max_cents is null or p_deposit_cents <= max_cents)
    order by min_cents desc
    limit 1
  ), 0) into v_pct;
  v_pct := v_pct + greatest(coalesce(p_bonus_boost_pts, 0), 0);
  v_bonus := (p_deposit_cents * v_pct) / 100;

  select bonus_expiry_days into v_days from wallet_config where id = 1;

  update wallets
     set cash_balance_cents = cash_balance_cents + p_deposit_cents, updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;
  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'deposit', p_deposit_cents, v_cash_after, v_bonus_after, 'Deposit');

  if v_bonus > 0 then
    update wallets
       set bonus_balance_cents = bonus_balance_cents + v_bonus, updated_at = now()
     where id = v_wallet
     returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;
    insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
      values (v_wallet, v_bonus, v_bonus, now() + (v_days || ' days')::interval);
    insert into wallet_transactions
      (wallet_id, type, bonus_delta_cents, cash_balance_after_cents, bonus_balance_after_cents, note)
      values (v_wallet, 'bonus_grant', v_bonus, v_cash_after, v_bonus_after, 'Deposit bonus');
  end if;
end; $$;

-- Re-apply the 0019 lockdown: the new signature is a NEW function, and
-- Postgres grants EXECUTE to PUBLIC on new functions by default. Only the
-- service role (Stripe webhook) may call it.
revoke all on function public.apply_deposit(uuid, bigint, int) from public;
revoke all on function public.apply_deposit(uuid, bigint, int) from anon;
revoke all on function public.apply_deposit(uuid, bigint, int) from authenticated;
grant execute on function public.apply_deposit(uuid, bigint, int) to service_role;
