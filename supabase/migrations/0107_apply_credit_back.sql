-- =============================================================================
-- Hearth - credit back the apply fee to every non-chosen applicant (0106)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHAT CHANGES: when a homeowner picks an applicant, every OTHER live applicant
-- now gets 100% of their apply fee back automatically, as EXPIRING WALLET
-- CREDIT (a standard bonus grant on the existing 60-day rails, never cash).
-- The marketing promise this backs: "You never lose money on a job you didn't
-- get." Before this, only a pro's FIRST ever application was protected
-- (0041's guarantee, licensed-only, once-ever); a second or third applicant who
-- lost simply forfeited their fee. This makes losing a pick cost the pro
-- nothing.
--
-- BASE: this recreates choose_applicant() from its LATEST existing definition,
-- 0077_lock_contractor_leads.sql (confirmed the latest by grepping every
-- migration for "create or replace function public.choose_applicant"; 0087 and
-- 0092 only reference it in comments and do not redefine it). Every existing
-- behavior of the 0077 body is preserved byte-for-byte:
--   - the perform set_config('hearth.lead_write', 'on', true) privileged flag
--     (0077) that lets it write the locked contractor_leads columns,
--   - the owns_property() ownership check,
--   - the FOR UPDATE lock on the lead + the idempotent "already assigned"
--     handling (a repeat pick of the same pro is a no-op; a pick of a taken
--     job raises),
--   - the assignment UPDATE (contractor_id / status='accepted' / paid),
--   - marking the chosen application 'chosen' and the rest 'declined',
--   - the FULL ghost_recharge revival path for a chosen pro whose fee had been
--     ghost-refunded (0028): re-charge cash-first-then-bonus if the wallet can
--     cover it, else a zero-delta 'ghost_recharge_waived' ledger row, and on a
--     successful re-charge clear that application's refunded_at back to null.
--
-- WHAT IS ADDED (the only new logic): after the losers are marked 'declined',
-- loop over every declined application on this lead with refunded_at IS NULL and
-- fee_cents > 0 (and no 0041 first-application guarantee already paid for this
-- lead - see DOUBLE-REFUND PREVENTION) and, for each, credit the full fee_cents
-- back as bonus:
--   1. get_or_create_wallet(loser),
--   2. insert a bonus_grants row (amount = remaining = fee_cents, expiring in
--      wallet_config.bonus_expiry_days days, default 60),
--   3. increment wallets.bonus_balance_cents,
--   4. insert a wallet_transactions ledger row of type 'apply_credit_back'
--      (bonus_delta_cents positive, correct balance-after columns, lead_id set,
--      note 'Not chosen: apply fee returned as credit'),
--   5. stamp lead_applications.refunded_at = now() on that application.
--
-- DOUBLE-REFUND PREVENTION (why step 5's stamp is load-bearing):
--   * The chosen application is NEVER credited: it has status 'chosen', and the
--     loop only touches status='declined' rows other than the picked one.
--   * A loser who was ALREADY ghost-refunded (0028) is NEVER credited a second
--     time: ghost_refund_application() sets refunded_at but leaves status
--     'applied', so the decline UPDATE above flips it to 'declined' while
--     refunded_at stays non-null - the "refunded_at IS NULL" filter skips it.
--   * Stamping refunded_at = now() on each freshly-credited loser both RECORDS
--     the credit and EXCLUDES that row from every other refund path going
--     forward: ghost_refund_application() requires status='applied' AND
--     refunded_at IS NULL (a declined, stamped row fails both), and 0041's
--     guarantee_refund_first_application() bails on refunded_at IS NOT NULL. So
--     no cron can ever pay this same fee back twice.
--   * A loser who ALREADY got 0041's first-application guarantee for THIS lead
--     is NEVER credited again. 0041 (guarantee_refund_first_application) pays a
--     losing first application back as a 'first_apply_guarantee'
--     wallet_transactions row and, by design, does NOT set refunded_at (that
--     flag belongs to ghost protection, and 0041's header spells out why it
--     must stay untouched). So the "refunded_at IS NULL" filter alone would NOT
--     skip such a row and would double-pay the fee. The loop's WHERE therefore
--     also excludes any loser whose contractor already has a
--     'first_apply_guarantee' ledger row with lead_id = this lead (joined back
--     to the contractor via wallets.contractor_id). Ordering-independent: it
--     holds whether the cron paid the guarantee before this pick or the
--     guarantee is attempted after (0041 re-checks status/refunded_at under a
--     lock and bails once the pick has resolved the application).
--   * This function is idempotent on re-entry for an already-assigned lead: the
--     early "already assigned" branch returns before any credit runs, so a
--     repeat pick cannot re-credit anyone.
--
-- INTERACTION WITH THE REVIVAL RE-CHARGE: the ghost_recharge block only ever
-- touches the CHOSEN application (p_application). The credit-back loop only ever
-- touches the DECLINED losers. They never operate on the same row, so their
-- refunded_at writes cannot collide.
--
-- Idempotent: CREATE OR REPLACE, unchanged signature (preserves existing EXECUTE
-- grants). Safe to re-run.
-- =============================================================================

create or replace function public.choose_applicant(p_application uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_contractor uuid; v_owns boolean;
  v_lead_contractor uuid; v_lead_status text;
  v_fee bigint; v_refunded timestamptz;
  v_wallet uuid; v_cash bigint; v_bonus bigint; v_bonus_avail bigint;
  v_grant_sum bigint; v_cash_first boolean;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record;
  v_cash_after bigint; v_bonus_after bigint;
  -- NEW (credit-back): its own variables so nothing above is clobbered.
  v_expiry_days int;
  v_loser record;
  v_lwallet uuid;
  v_lcash_after bigint; v_lbonus_after bigint;
begin
  perform set_config('hearth.lead_write', 'on', true);

  select lead_id, contractor_id into v_lead, v_contractor
    from lead_applications where id = p_application;
  if v_lead is null then raise exception 'Application not found'; end if;

  select public.owns_property(cl.property_id) into v_owns
    from contractor_leads cl where cl.id = v_lead;
  if not coalesce(v_owns, false) then raise exception 'Not your job'; end if;

  -- Lock the lead so two picks serialize, and read its live assignment state.
  select contractor_id, status into v_lead_contractor, v_lead_status
    from contractor_leads where id = v_lead for update;

  -- Already assigned? A repeat pick of the same pro is an idempotent no-op;
  -- anything else means the job is taken and must not be silently reassigned.
  if v_lead_contractor is not null or coalesce(v_lead_status, 'new') <> 'new' then
    if v_lead_contractor = v_contractor then
      return;
    end if;
    raise exception 'This job has already been assigned';
  end if;

  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now()
   where id = v_lead and contractor_id is null and status = 'new';

  -- RETURNING (not the earlier snapshot) decides the re-charge: if the ghost
  -- cron refunded this row a moment ago, the post-lock values show it and the
  -- fee gets charged again below instead of being missed.
  update lead_applications set status = 'chosen'
   where id = p_application
   returning fee_cents, refunded_at into v_fee, v_refunded;
  update lead_applications set status = 'declined'
   where lead_id = v_lead and id <> p_application and status = 'applied';

  -- Revival re-charge (ghost protection).
  if v_refunded is not null and coalesce(v_fee, 0) > 0 then
    v_wallet := get_or_create_wallet(v_contractor);
    -- 0065 fix: FOR UPDATE so this recharge can't race a concurrent apply_to_lead
    -- (or another recharge) against the same wallet and read a stale balance.
    select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
      from wallets where id = v_wallet
      for update;
    v_cash := coalesce(v_cash, 0);
    v_bonus := coalesce(v_bonus, 0);

    -- Only bonus backed by live grants is spendable; capping at the grant sum
    -- means the FIFO drain below can never come up short mid-charge.
    select coalesce(sum(remaining_cents), 0) into v_grant_sum
      from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
    v_bonus_avail := least(v_bonus, v_grant_sum);

    if v_cash + v_bonus_avail >= v_fee then
      select spend_cash_first into v_cash_first from wallet_config where id = 1;
      if v_cash_first then
        v_from_cash := least(v_cash, v_fee);
        v_from_bonus := v_fee - v_from_cash;
      else
        v_from_bonus := least(v_bonus_avail, v_fee);
        v_from_cash := v_fee - v_from_bonus;
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
      end if;

      update wallets
         set cash_balance_cents  = cash_balance_cents  - v_from_cash,
             bonus_balance_cents = bonus_balance_cents - v_from_bonus,
             updated_at = now()
       where id = v_wallet
       returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

      insert into wallet_transactions
        (wallet_id, type, cash_delta_cents, bonus_delta_cents,
         cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
        values (v_wallet, 'ghost_recharge', -v_from_cash, -v_from_bonus,
                v_cash_after, v_bonus_after, v_lead,
                'Fee re-charged: homeowner picked you after a ghost refund');

      -- The refund is paid back, so the application is a normal paid one again.
      update lead_applications set refunded_at = null where id = p_application;
    else
      insert into wallet_transactions
        (wallet_id, type, cash_delta_cents, bonus_delta_cents,
         cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
        values (v_wallet, 'ghost_recharge_waived', 0, 0,
                v_cash, v_bonus, v_lead,
                'Ghost re-charge waived: wallet could not cover the fee');
    end if;
  end if;

  -- ---- NEW: credit back the non-chosen applicants -----------------------------
  -- Every declined applicant on this lead who still has a live, never-refunded,
  -- non-zero fee gets 100% of it back as expiring bonus credit. The chosen row
  -- (status 'chosen') is not in this set; an already ghost-refunded loser
  -- (refunded_at not null) is skipped, and so is a loser who already received
  -- 0041's first-application guarantee for this lead (a 'first_apply_guarantee'
  -- ledger row, which does NOT set refunded_at) - see the NOT EXISTS below and
  -- the header's double-refund reasoning - so nobody is refunded twice. Stamping
  -- refunded_at = now() on each credited row both records the credit and closes
  -- it off from ghost_refund_application (needs status='applied' AND refunded_at
  -- null) and 0041's first-application guarantee (bails on refunded_at not null)
  -- - see the header for the full double-refund reasoning.
  select coalesce(bonus_expiry_days, 60) into v_expiry_days
    from wallet_config where id = 1;
  v_expiry_days := coalesce(v_expiry_days, 60);

  for v_loser in
    select id, contractor_id, fee_cents
      from lead_applications
     where lead_id = v_lead
       and id <> p_application
       and status = 'declined'
       and refunded_at is null
       and coalesce(fee_cents, 0) > 0
       -- Skip a loser whose fee was ALREADY returned by 0041's first-application
       -- guarantee for THIS lead. That path pays the fee back as a
       -- 'first_apply_guarantee' wallet_transactions row and deliberately does
       -- NOT stamp lead_applications.refunded_at (see 0041's header), so the
       -- refunded_at IS NULL filter above cannot see it on its own. Without this
       -- exclusion a losing first application that already got the guarantee
       -- would be credited a SECOND time here. wallet_transactions.lead_id is
       -- the lead the guarantee was paid for; the wallet joins back to the
       -- contractor via wallets.contractor_id.
       and not exists (
         select 1
           from wallet_transactions wt
           join wallets w on w.id = wt.wallet_id
          where w.contractor_id = lead_applications.contractor_id
            and wt.type = 'first_apply_guarantee'
            and wt.lead_id = v_lead
       )
  loop
    v_lwallet := get_or_create_wallet(v_loser.contractor_id);

    insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
      values (v_lwallet, v_loser.fee_cents, v_loser.fee_cents,
              now() + (v_expiry_days || ' days')::interval);

    update wallets
       set bonus_balance_cents = bonus_balance_cents + v_loser.fee_cents,
           updated_at = now()
     where id = v_lwallet
     returning cash_balance_cents, bonus_balance_cents
       into v_lcash_after, v_lbonus_after;

    insert into wallet_transactions
      (wallet_id, type, cash_delta_cents, bonus_delta_cents,
       cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
      values (v_lwallet, 'apply_credit_back', 0, v_loser.fee_cents,
              v_lcash_after, v_lbonus_after, v_lead,
              'Not chosen: apply fee returned as credit');

    update lead_applications set refunded_at = now() where id = v_loser.id;
  end loop;
end; $$;
