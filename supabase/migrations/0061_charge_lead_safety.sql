-- =============================================================================
-- Hearth - charge_lead safety (0059)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Idempotent and safe to
-- re-run.
--
-- charge_lead was left on its 0010 body when 0058 fixed the same bonus-drain
-- bug in apply_to_lead and choose_applicant. Two fixes here:
--
--  1. BONUS DRAIN WITHOUT ROLLBACK. The 0010 body gated sufficiency on the
--     raw wallets.bonus_balance_cents counter, drained bonus_grants FIFO
--     (restricted to live grants), and on a shortfall did `return false`
--     AFTER the grant updates. A plain PL/pgSQL return does not roll back,
--     so live grants were zeroed while the wallet counter was never
--     decremented and no ledger row was written: the pro's live bonus was
--     destroyed and the counter left permanently overstated. Reachable
--     whenever the counter exceeds the live grant sum, which happens for up
--     to a day after any grant expires (expire_bonus only sweeps daily at
--     08:00 UTC). Fixed by porting the 0058 pattern verbatim: cap spendable
--     bonus at the live grant sum up front, so the insufficient-funds check
--     is honest and the FIFO drain can never come up short.
--
--  2. EXECUTE LOCKDOWN. 0019 deliberately left charge_lead callable by
--     authenticated as a "legitimate client entry point", but no client code
--     calls it anymore (unlocking happens only through apply_to_lead /
--     choose_applicant), and it prices from raw payout_amount with no aging
--     discount, unlike every live charge path. A hand-crafted
--     supabase.rpc('charge_lead') was the only way to reach bug #1. The
--     function is kept (service_role only) rather than dropped, but no
--     client role may execute it; this supersedes 0019's closing comment
--     that listed charge_lead among the intentionally-authenticated
--     functions.
-- =============================================================================

-- Identical to the 0010 version except spendable bonus is measured by the
-- live grant sum (v_bonus_avail), not the raw wallet counter, matching
-- apply_to_lead / choose_applicant after 0058. Signature is unchanged, so
-- CREATE OR REPLACE preserves existing grants; the revokes below then strip
-- the client roles.
create or replace function public.charge_lead(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_price bigint; v_paid boolean;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record;
  v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  select id into v_contractor from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  select round(payout_amount * 100)::bigint, paid into v_price, v_paid
    from contractor_leads where id = p_lead and contractor_id = v_contractor;
  if v_price is null then raise exception 'Lead not found'; end if;
  if v_paid then return true; end if;

  v_wallet := get_or_create_wallet(v_contractor);
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO
  -- drain below finds enough, so it can never zero out grants and then bail
  -- without charging (the pre-0059 bug).
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: caller should prompt a deposit
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
    if v_remaining > 0 then return false; end if;  -- unreachable safety net
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  update contractor_leads set paid = true, paid_at = now() where id = p_lead;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'lead_charge', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Lead unlocked');

  return true;
end; $$;

-- Lock it away from all client roles. CREATE OR REPLACE preserved the old
-- grants (EXECUTE to PUBLIC from 0010's CREATE, confirmed kept by 0019), so
-- the revokes are load-bearing, not ceremony.
revoke all on function public.charge_lead(uuid) from public;
revoke all on function public.charge_lead(uuid) from anon;
revoke all on function public.charge_lead(uuid) from authenticated;
grant execute on function public.charge_lead(uuid) to service_role;
