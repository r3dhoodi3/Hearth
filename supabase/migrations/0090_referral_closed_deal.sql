-- =============================================================================
-- Hearth - pro-referral reward: closed, paid deals only (0088)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. As of 2026-07-19 the
-- live DB is fully caught up through 0087, so this is the next migration to
-- apply, in order, with no gaps.
--
-- WHAT CHANGED AND WHY (owner decision): the $25+$25 referral reward
-- (0044_pro_referrals.sql, tightened by 0084's sybil-dealing guard) fired the
-- instant a referred pro's application/lead reached a WINNING state - a
-- 'chosen' application, or an assigned lead with paid = true. That is too
-- early: a "win" is not revenue. A homeowner can choose an applicant and the
-- job can still fall through (never actually gets done, never actually gets
-- paid past the apply fee), and 'paid = true' on an assigned lead includes
-- rehire_pro's free ($0 payout) leads and application fees that were later
-- waived. The owner wants the reward tied to a REAL, CLOSED, PAID deal: the
-- referred pro's job reached contractor_leads.status = 'closed' AND the fee
-- behind it was actually paid (not refunded, not waived, not a $0 rehire).
-- On top of that, a 21-day HOLD after close before the reward can fire, so a
-- job that gets reopened/disputed/reversed shortly after closing has time to
-- do so before money moves.
--
-- THE 21-DAY HOLD: v_hold constant interval := interval '21 days' inside
-- grant_referral_rewards(), and a matching REFERRAL_HOLD_DAYS = 21 constant in
-- the cron route (src/app/api/cron/referral-rewards/route.ts). Both must stay
-- in sync; the cron's copy is a pre-filter only; the DB function is the sole
-- authority on whether the hold has actually elapsed.
--
-- WHY THERE IS NO CLAWBACK FUNCTION (documented residual): once a deal
-- qualifies (closed, paid, past the hold) and the reward is granted, nothing
-- in this migration reverses it if the underlying deal is later refunded.
-- This is deliberate, not an oversight: every refund path in the schema is
-- already unreachable from a qualifying deal. ghost_refund_application()
-- (0028) requires the application's status = 'applied' AND the lead's status
-- = 'new' - both are already false once an application reaches 'chosen' and
-- its lead reaches 'closed', so a refund can never fire against a deal that
-- passed the qualifying check above. There is no other live refund path that
-- can touch a lead post-close. If a manual/admin refund path is ever added
-- for closed deals, a referral clawback must ship in the SAME migration that
-- adds it - this is a residual gap, not a closed one.
--
-- Part 1: contractor_leads.closed_at, stamped by enforce_contractor_leads_locked()
--   whenever status transitions into/out of 'closed', for ANY update (privileged
--   or not, any trigger depth) - this is the hold clock's source of truth.
-- Part 2: grant_referral_rewards(uuid), latest body from 0084, with the win
--   check replaced by a qualifying-closed-deal check, the sybil-guard chooser
--   resolution filtered to match, a $500 lifetime cap per referrer wallet, and
--   a once-per-referred-USER-ever guard mirroring 0084's own
--   guarantee_refund_first_application fix.
--
-- Idempotent: CREATE OR REPLACE for functions, ADD COLUMN IF NOT EXISTS, and
-- the backfill UPDATE only touches rows still missing closed_at so re-running
-- it is a no-op the second time. Safe to re-run.
--
-- This migration was written and reasoned about, but NOT executed against any
-- database (per instructions). Dry-run against a staging copy of the live
-- schema before applying to production.
-- =============================================================================


-- =============================================================================
-- Part 1: contractor_leads.closed_at
-- =============================================================================
alter table public.contractor_leads
  add column if not exists closed_at timestamptz;

comment on column public.contractor_leads.closed_at is
  'Set by enforce_contractor_leads_locked() when status enters ''closed'', '
  'cleared when it leaves ''closed''. Never client-writable. The referral '
  'reward''s 21-day hold clock (grant_referral_rewards) keys off this column.';

-- Backfill: existing closed leads get their 21-day hold started at migration
-- time, deliberately conservative (no instant payouts on old deals - a lead
-- that closed years ago does not retroactively pass its hold the instant this
-- migration runs; it starts the clock today instead).
--
-- ORDER MATTERS: this MUST run before the CREATE OR REPLACE below installs
-- the new trigger body. The new enforce_contractor_leads_locked() derives
-- closed_at EXCLUSIVELY from status transitions (old.status vs new.status)
-- and reverts any direct write to closed_at, including a plain UPDATE like
-- this one - new.closed_at := old.closed_at runs on every UPDATE, and a
-- status-only-unchanged backfill row has old.status = new.status = 'closed',
-- so the transition branches never fire either. Run this backfill against
-- that new trigger body and it silently reverts to a no-op: every matching
-- row keeps closed_at null. The pre-0088 (0087) trigger body has no such
-- logic at all, so running the backfill first, while the old body is still
-- installed, is what makes the UPDATE actually stick.
update public.contractor_leads
   set closed_at = now()
 where status = 'closed' and closed_at is null;

-- ---- enforce_contractor_leads_locked(): stamp closed_at + 0087's body, unchanged ----
create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.lead_write', true), '') = 'on';
  v_is_party   boolean;
  v_has_live_apps boolean;
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
    -- 0084 fix (finding #5, unchanged): pg_trigger_depth() > 1 means this
    -- UPDATE was fired from inside another trigger - the FK's ON DELETE SET
    -- NULL action on contractor_leads.contractor_id when a contractors row
    -- is deleted (0005), a nested trigger invocation, not a direct client
    -- statement. Skip ALL anti-forgery stripping (including the status guard
    -- below) only for that RI-cascade case, so account deletion (CCPA erase)
    -- still works. Direct client writes are always depth = 1.
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

      -- ---- 0087 addition: status transition guard -------------------------
      if new.status is distinct from old.status then
        v_is_party := coalesce(public.can_access_lead(old.id), false);
        if not v_is_party then
          -- Should be unreachable given RLS, but never let a non-party's
          -- status write through if this ever runs outside RLS's scope.
          new.status := old.status;
        elsif new.status = 'accepted' then
          -- (b) 'accepted' is normally set together with contractor_id by
          -- choose_applicant (privileged). A non-privileged write to 'accepted'
          -- is legitimate ONLY as a pro un-marking their OWN already-assigned
          -- lead from a mistaken 'closed'/'lost' back to active (the pro's
          -- JobStatusSelect dropdown offers exactly this). Allow that; block the
          -- real hole: a homeowner or stranger self-accepting an UNASSIGNED
          -- lead (contractor_id null), or anyone accepting a lead not assigned
          -- to their own contractor.
          if old.contractor_id is null
             or old.contractor_id not in (
               select id from public.contractors where user_id = auth.uid()
             )
             or old.status not in ('closed', 'lost') then
            new.status := old.status;
          end if;
        elsif old.status in ('accepted', 'closed', 'lost') and new.status = 'new' then
          -- (c) No moving a lead backward to 'new' once it has left that
          -- state.
          new.status := old.status;
        elsif old.contractor_id is null and old.status = 'new'
              and new.status in ('closed', 'lost') then
          -- (d) Mirrors closeJobAction: once a lead has a live (non-refunded)
          -- application, the homeowner must pick an applicant rather than
          -- force it closed/lost directly. A still-unassigned lead with NO
          -- applications is unaffected (closeJobAction's normal cancel path,
          -- and the app actually DELETEs there rather than updating status,
          -- but this guard covers the update path too for defense-in-depth).
          select exists (
            select 1 from lead_applications
            where lead_id = old.id and refunded_at is null
          ) into v_has_live_apps;
          if v_has_live_apps then
            new.status := old.status;
          end if;
        end if;
      end if;
      -- ---- end 0087 addition -----------------------------------------------
    end if;

    -- 0088 addition: closed_at is derived bookkeeping, never client-writable,
    -- and stamping must also work for privileged RPC writes (choose_applicant,
    -- rehire_pro, the CCPA-deletion RI cascade at any trigger depth), hence it
    -- runs for every UPDATE, privileged or not, at any trigger depth - it is
    -- NOT nested inside the `not v_privileged and pg_trigger_depth() <= 1`
    -- guard above. It MUST run here, at the very end of the UPDATE branch,
    -- immediately before return new, rather than at the top: it has to derive
    -- from the FINAL new.status, after 0087's anti-forgery guards above have
    -- already reverted any illegitimate status write, not from the tentative
    -- client-supplied new.status those guards haven't checked yet. Deriving
    -- from the tentative value would let a reverted forgery still corrupt
    -- closed_at - e.g. a contractor sends status = 'new' on their own closed
    -- lead; rule (c) above reverts new.status back to 'closed'; if this block
    -- ran first (against the pre-revert 'new'), it would have already nulled
    -- closed_at, leaving a final row of status = 'closed' with
    -- closed_at = null and the hold clock silently erased. Running last means
    -- this block only ever sees the status the row will actually end up with.
    -- Always revert any client-supplied closed_at first, then derive from the
    -- real (final) transition. Clearing closed_at on un-close means a pro
    -- un-marking a mistaken Won (back to 'accepted', per 0087's own allowed
    -- reversal) restarts the hold clock honestly rather than keeping a stale
    -- timestamp from the earlier, later-undone close.
    new.closed_at := old.closed_at;
    if new.status = 'closed' and old.status is distinct from 'closed' then
      new.closed_at := now();
    elsif new.status is distinct from 'closed' and old.status = 'closed' then
      new.closed_at := null;
    end if;

    return new;
  end if;

  return new;
end;
$$;
-- No explicit grants to restate: this is a trigger function (invoked by the
-- system, not called directly), and no prior migration granted EXECUTE on it
-- to any role. The trigger `contractor_leads_locked` (0077) already points at
-- this function name/signature, so CREATE OR REPLACE takes effect
-- immediately without needing to drop/recreate the trigger.


-- =============================================================================
-- Part 2: grant_referral_rewards(uuid) - reward on closed, paid deals only
-- =============================================================================
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
  v_hold constant interval := interval '21 days';
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

  -- 0088 change: the reward now requires a qualifying CLOSED, PAID deal, not
  -- merely a win. Two shapes, matching the two ways a pro can be assigned a
  -- job: Shape A is a marketplace application the homeowner chose, where the
  -- application itself was a real (non-refunded, fee > 0) charge and the
  -- lead it won later reached 'closed' with its 21-day hold (v_hold) elapsed.
  -- Shape B is a directly-assigned lead (no application row at all) that was
  -- actually paid with a nonzero payout and likewise closed past the hold.
  --
  -- Shape A additionally excludes a ghost-refund revival that
  -- choose_applicant() waived the re-charge on: choose_applicant() can revive
  -- a ghost-refunded application and WAIVE the re-charge when the wallet
  -- cannot cover it, so that pro won without ever net-paying a fee for it. A
  -- ghost_recharge_waived ledger row keyed to that lead means exactly that
  -- happened, so it disqualifies the deal from the reward.
  if not (
    exists (
      select 1
      from lead_applications la
      join contractor_leads cl on cl.id = la.lead_id
      where la.contractor_id = p_referred
        and la.status = 'chosen'
        and la.refunded_at is null
        and coalesce(la.fee_cents, 0) > 0
        and cl.contractor_id = p_referred
        and cl.status = 'closed'
        and cl.closed_at is not null
        and cl.closed_at <= now() - v_hold
        and not exists (
          select 1 from wallet_transactions wt
          join wallets w on w.id = wt.wallet_id
          where w.contractor_id = p_referred
            and wt.type = 'ghost_recharge_waived'
            and wt.lead_id = cl.id
        )
    )
    or exists (
      -- payout_amount > 0 excludes rehire_pro's free leads (payout_amount = 0,
      -- paid = true): a free rehire is a real closed job but not a real fee
      -- payment, so it must not trigger the reward either.
      select 1
      from contractor_leads cl
      where cl.contractor_id = p_referred
        and cl.paid = true
        and coalesce(cl.payout_amount, 0) > 0
        and cl.status = 'closed'
        and cl.closed_at is not null
        and cl.closed_at <= now() - v_hold
    )
  ) then
    return false;
  end if;

  -- 0084 fix (finding #4): sybil self-dealing guard. choose_applicant() is
  -- free and never required the chosen applicant to be a stranger, so one
  -- reusable homeowner account paired with a referred contractor could win
  -- their own posted job and collect the $25+$25 referral reward at ~$0 real
  -- cost. Resolve the referred pro's own user_id and the winning job's
  -- owner (chooser) user_id - checking both qualifying-deal shapes above,
  -- Shape A first, Shape B as the fallback - and skip the reward
  -- (return false, no grant, no error) when they are the same auth user.
  -- A legitimate referral (distinct homeowner) is unaffected.
  select c.user_id into v_referred_user from contractors c where c.id = p_referred;

  -- 0088 change: filtered to the SAME qualifying-deal conditions as the check
  -- above, so this resolves the chooser of the deal that actually qualifies
  -- for the reward, not just any win.
  select p.user_id, p.id into v_chooser_user, v_property_id
    from lead_applications la
    join contractor_leads cl on cl.id = la.lead_id
    join properties p on p.id = cl.property_id
    where la.contractor_id = p_referred
      and la.status = 'chosen'
      and la.refunded_at is null
      and coalesce(la.fee_cents, 0) > 0
      and cl.contractor_id = p_referred
      and cl.status = 'closed'
      and cl.closed_at is not null
      and cl.closed_at <= now() - v_hold
      and not exists (
        select 1 from wallet_transactions wt
        join wallets w on w.id = wt.wallet_id
        where w.contractor_id = p_referred
          and wt.type = 'ghost_recharge_waived'
          and wt.lead_id = cl.id
      )
    order by la.created_at asc
    limit 1;

  if v_chooser_user is null then
    select p.user_id, p.id into v_chooser_user, v_property_id
      from contractor_leads cl
      join properties p on p.id = cl.property_id
      where cl.contractor_id = p_referred
        and cl.paid = true
        and coalesce(cl.payout_amount, 0) > 0
        and cl.status = 'closed'
        and cl.closed_at is not null
        and cl.closed_at <= now() - v_hold
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

  -- 0088 addition: $500 lifetime ceiling per referrer wallet, per the 2026-07
  -- referral-abuse research. Change the literal to tune.
  if (
    select coalesce(sum(bonus_delta_cents), 0) from wallet_transactions
    where wallet_id = v_referrer_wallet and type = 'referral_reward'
  ) >= 50000 then
    return false;
  end if;

  -- 0088 addition: once per USER, ever, on top of the once-per-wallet guard
  -- above, mirroring 0084's guarantee_refund_first_application fix (itself
  -- mirroring 0075_winback_user_guard.sql) exactly: a contractor/wallet can be
  -- deleted and rebuilt under the same auth account, which would otherwise
  -- reset the wallet-ledger guard above and let the referred side collect a
  -- second time. claim_promo() inserts (user_id, 'referral_reward_referred')
  -- and atomically reports whether it was new; false here means this account
  -- already collected a referral reward under some contractor row, so grant
  -- nothing even though this particular wallet's own ledger is clean. Skipped
  -- only when the referred contractor has no user_id (a deleted-user orphan,
  -- per 0005's "on delete set null") - there is no account to key on or to
  -- rebuild, so the wallet-only guard above is unchanged for that case, same
  -- treatment as 0075/0084.
  if v_referred_user is not null
     and not coalesce(claim_promo(v_referred_user, 'referral_reward_referred', p_referred::text), false)
  then
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


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. Part 1's closed_at stamping runs unconditionally at the END of the
--    UPDATE branch, after the v_privileged / pg_trigger_depth() guard (and
--    everything inside it, including 0087's status-transition reverts) has
--    already settled new.status to its final value, so it fires for every
--    UPDATE regardless of who wrote it - direct client writes, choose_applicant/
--    rehire_pro (privileged), and the CCPA-deletion RI cascade (depth > 1)
--    alike - while always deriving from the status the row will actually end
--    up with, never a tentative client-supplied value a guard is about to
--    revert. Dry-run: confirm a status change into
--    'closed' stamps closed_at = now(), a status change out of 'closed'
--    (back to 'accepted', per 0087's own allowed reversal) clears it back to
--    null, and a client-supplied closed_at on an unrelated column update is
--    always reverted to the old value first regardless of status.
--
-- 2. The backfill UPDATE runs once effectively: any row it stamps now has
--    closed_at is not null, so a re-run of this migration finds nothing left
--    to backfill. Existing closed deals get a hold clock that starts at
--    migration time, not at their true (unknown, pre-migration) close time -
--    deliberately conservative, matches the header's stated intent.
--
-- 3. Shape A's ghost_recharge_waived exclusion assumes wallet_transactions
--    still carries lead_id on that row type, unchanged since 0028/0058/0065/
--    0077 (confirmed by reading 0077_lock_contractor_leads.sql directly - the
--    insert into wallet_transactions for the waived branch passes v_lead as
--    lead_id).
--
-- 4. This migration was written and reasoned about, but NOT executed against
--    any database (per instructions). Dry-run against a staging copy of the
--    live schema before applying to production, per this file's own header.
--
-- 5. On a DB where this file already ran with the OLD (backfill-after-trigger)
--    statement order, re-running this corrected file is harmless: the
--    backfill UPDATE matches zero rows for any lead the old order already
--    (mis)stamped, since WHERE closed_at IS NULL only catches rows the old
--    trigger body never touched. It does NOT retroactively fix closed leads
--    still sitting at closed_at = null from that earlier run. Those need the
--    same manual fixup applied live: disable the trigger, backfill, re-enable
--    it -
--      alter table public.contractor_leads disable trigger contractor_leads_locked;
--      update public.contractor_leads set closed_at = now() where status = 'closed' and closed_at is null;
--      alter table public.contractor_leads enable trigger contractor_leads_locked;
--    - run once, by hand, against that DB; this file cannot do it for you
--    since CREATE OR REPLACE FUNCTION always installs the new trigger body
--    before any later statement in the same file runs.
-- =============================================================================
