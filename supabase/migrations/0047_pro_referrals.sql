-- =============================================================================
-- Hearth - pro-refers-pro referrals (0044)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Contractors recruit contractors. A new pro enters an existing pro's referral
-- code (their slug, or the first 8 chars of their contractor id) during
-- company setup, and that attribution is stored as contractors.referred_by,
-- stamped with referred_attributed_at. Attribution happens ONLY at onboarding:
-- the app writes referred_by exclusively on the INSERT that creates the
-- company row, never on later edits, and this function refuses any stamp more
-- than 30 days after the row's creation as defense in depth.
--
-- THE REWARD fires on a real revenue event only: when the referred pro WINS
-- THEIR FIRST JOB (a lead_applications row with status 'chosen', or a
-- contractor_leads row assigned to them with paid = true, the same terminal
-- shapes 0041's guarantee logic keys off). Then BOTH sides get $25 (2500
-- cents) of expiring bonus credit (90-day tranche), never cash. Once per
-- referred pro, EVER, and a referrer earns at most 10 rewarded referrals per
-- calendar year. Nothing here reads or conditions on reviews.
--
-- The daily cron (src/app/api/cron/referral-rewards) finds rough candidates
-- and calls grant_referral_rewards() per referred contractor. Every rule is
-- re-checked atomically in here behind FOR UPDATE locks on BOTH wallets, so
-- cron re-runs and overlapping runs can never double-grant.
--
-- choose_applicant(), the ghost protection functions, and the first-apply
-- guarantee are untouched by this migration.
--
-- Safe to re-run.
-- =============================================================================

-- ---- Attribution columns ------------------------------------------------------
alter table public.contractors
  add column if not exists referred_by uuid references public.contractors (id) on delete set null;
alter table public.contractors
  add column if not exists referred_attributed_at timestamptz;

-- The cron scans for attributed pros; most rows have no referrer.
create index if not exists contractors_referred_by_idx
  on public.contractors (referred_by)
  where referred_by is not null;

-- ---- Reward both sides of a referral -------------------------------------------
-- Called only by the daily cron (service role). Returns true iff it granted.
create or replace function public.grant_referral_rewards(p_referred uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_ref record;
  v_referrer uuid;
  v_referred_wallet uuid;
  v_referrer_wallet uuid;
  v_cash_after bigint;
  v_bonus_after bigint;
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
revoke all on function public.grant_referral_rewards(uuid) from public;
revoke all on function public.grant_referral_rewards(uuid) from anon;
revoke all on function public.grant_referral_rewards(uuid) from authenticated;
grant execute on function public.grant_referral_rewards(uuid) to service_role;
