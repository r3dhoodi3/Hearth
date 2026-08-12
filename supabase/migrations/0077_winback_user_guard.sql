-- =============================================================================
-- Hearth - winback credit: survive a contractor/wallet rebuild (0075)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- 0038's guard is once-per-WALLET-ever (a wallet_transactions row on the
-- wallet). 0072 made it one contractor row per user, which already stops a
-- single account from minting two wallets and double-collecting. What it
-- does not stop: a user deletes their contractor row (cascades the wallet,
-- per 0010) and onboards a fresh one under the SAME auth account. That
-- rebuilds a brand-new, empty wallet with no winback_credit row, so 0038's
-- guard alone would grant a second time to the same person.
--
-- Fix: also record the grant against the user, not just the wallet, via
-- 0071's promo_claims (key 'winback_credit', ref = contractor id). That
-- claim outlives any contractor/wallet rebuild for the same auth user, so
-- the guard now survives identity being rebuilt underneath it, not just
-- replayed against the same row.
--
-- This does NOT address N separate accounts (distinct auth users) each
-- claiming once - that needs identity dedup (email/phone/device), which is
-- a deliberately deferred, separate, heavier decision (see 0072's non-unique
-- contact_phone/contact_email indexes: soft signals for human review only,
-- not an automated block, because a hard constraint there would also reject
-- legitimate franchises/shared office lines).
--
-- Everything else here is 0038 unchanged: same locking, same 14-day/broke-
-- and-quiet eligibility, same return contract (true iff granted). The cron
-- caller (src/app/api/cron/pro-winback) already treats any non-true return
-- as "skip, don't grant" and loops on to the next candidate, so it needs no
-- change for this to take effect.
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.grant_winback_credit(p_contractor uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_created timestamptz;
  v_user uuid;
  v_wallet uuid;
  v_cash bigint;
  v_bonus bigint;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  if p_contractor is null then return false; end if;
  select created_at, user_id into v_created, v_user from contractors where id = p_contractor;
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

  -- 0075: once per USER, ever, on top of the once-per-wallet guard above.
  -- claim_promo() inserts (user_id, 'winback_credit') and atomically reports
  -- whether it was new; false here means this account already collected the
  -- credit under some contractor row, so grant nothing even though this
  -- particular wallet's own ledger is clean. Skipped only when the
  -- contractor has no user_id (a deleted-user orphan, per 0005's "on delete
  -- set null") - there is no account to key on or to rebuild, so the
  -- wallet-only guard above is unchanged for that case, same as pre-0075.
  if v_user is not null
     and not coalesce(claim_promo(v_user, 'winback_credit', p_contractor::text), false)
  then
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
