-- =============================================================================
-- Hearth - referral money leak, message flood gap, properties grant fix (0089)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. As of 2026-07-19 the
-- live DB is fully caught up through 0088, so this is the next migration to
-- apply, in order, with no gaps.
--
-- Three fixes, one per section below:
--
-- FIX 1 (CONFIRMED money leak in 0088's grant_referral_rewards): Shape B (the
-- directly-assigned-lead path, no application row) checks contractor_leads.paid
-- = true and payout_amount > 0, but never checks whether that fee was later
-- WAIVED. Sequence: a pro applies to a lead (creating an application row),
-- gets ghost-refunded, spends the refund elsewhere, then the homeowner picks
-- that same pro anyway via choose_applicant - which sets contractor_leads.paid
-- = true AND logs a wallet_transactions row of type 'ghost_recharge_waived'
-- for that lead, because the pro's wallet could not cover the re-charge. The
-- pro never net-paid a cent for that deal, yet Shape B's paid/payout_amount
-- check alone is satisfied. Shape A already excludes this exact scenario (its
-- la.refunded_at is null / fee_cents > 0 filters plus its own
-- ghost_recharge_waived exclusion), but the overall gate is Shape A OR Shape
-- B, so Shape B alone still lets a waived-fee deal through and wrongly fires
-- the $25+$25 reward. Fixed by adding the identical ghost_recharge_waived
-- exclusion to Shape B, mirroring Shape A, in BOTH places Shape B's condition
-- appears (the main qualifying-deal check and the chooser-resolution
-- fallback).
--
-- FIX 2 (CONFIRMED exploitable flood): public.messages has no send-rate
-- limit. A red-team run inserted 40 rows in 604ms directly via the anon/
-- authenticated key; 0086_message_length_limit.sql (referenced here, not
-- modified) only added a length CHECK, which does nothing against a tight
-- insert loop. Adds a BEFORE INSERT trigger enforcing 30 messages per 60
-- second window per sender, mirroring 0087_med_security.sql's
-- enforce_support_messages_rate_limit()/enforce_reports_rate_limit() pattern
-- exactly (SECURITY DEFINER so it can write rate_limits despite the client's
-- own role, bucketed on auth.uid(), same rate_limits fixed-window upsert
-- shape). This is a SEPARATE trigger/function from 0087's
-- messages_sender_role_guard (enforce_message_sender_role()) - that trigger
-- is untouched; both BEFORE INSERT triggers on public.messages coexist.
--
-- FIX 3 (LOW cosmetic, from the access red-team): an anon direct SELECT
-- against public.properties throws `42501 permission denied for function
-- is_active_member` instead of returning zero rows, because the "properties
-- member select" RLS policy (0048_household_sharing.sql) calls
-- public.is_active_member(uuid), which 0048 grants EXECUTE on to
-- authenticated only - anon was never granted it, so the policy itself
-- errors instead of evaluating to false for an anonymous caller. Fixed by
-- granting EXECUTE on is_active_member(uuid) to anon; the function is
-- SECURITY DEFINER, takes only a property id, and returns a bare boolean
-- about household membership - it never returns row data, so letting anon
-- evaluate it (and get false, since anon has no auth.uid()) is safe.
--
-- Idempotent throughout: CREATE OR REPLACE for the function, DROP TRIGGER IF
-- EXISTS + CREATE for the trigger, and a plain GRANT (grants are additive and
-- re-running the same GRANT is a no-op). Safe to re-run.
--
-- This migration was written and reasoned about, but NOT executed against any
-- database (per instructions). Dry-run against a staging copy of the live
-- schema before applying to production.
-- =============================================================================


-- =============================================================================
-- FIX 1: grant_referral_rewards(uuid) - close Shape B's waived-fee gap
--
-- CURRENT body taken byte-for-byte from 0088_referral_closed_deal.sql. The
-- ONLY changes are the two `and not exists (... ghost_recharge_waived ...)`
-- blocks added to Shape B below (marked 0089 addition), one in the main
-- qualifying-deal check, one in the chooser-resolution fallback that mirrors
-- it. Nothing else in this function changes.
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
        -- 0089 fix (CONFIRMED money leak): Shape B had no ghost_recharge_waived
        -- exclusion, unlike Shape A directly above. A pro can apply (creating
        -- an application row), get ghost-refunded, spend the refund elsewhere,
        -- then still get PICKED by the homeowner - choose_applicant() sets
        -- contractor_leads.paid = true on that assignment AND logs a
        -- ghost_recharge_waived wallet_transactions row for the lead when the
        -- pro's wallet can't cover the re-charge, so the pro never net-paid.
        -- Without this clause, that scenario satisfied Shape B's
        -- paid = true / payout_amount > 0 check and wrongly triggered the
        -- $25+$25 reward on a deal with no real revenue behind it. Mirrors
        -- Shape A's own exclusion above exactly.
        and not exists (
          select 1 from wallet_transactions wt
          join wallets w on w.id = wt.wallet_id
          where w.contractor_id = p_referred
            and wt.type = 'ghost_recharge_waived'
            and wt.lead_id = cl.id
        )
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
        -- 0089 fix: same exclusion as the main Shape B check above, so this
        -- fallback never resolves a chooser from a waived-fee deal that the
        -- main check would (now) already reject.
        and not exists (
          select 1 from wallet_transactions wt
          join wallets w on w.id = wt.wallet_id
          where w.contractor_id = p_referred
            and wt.type = 'ghost_recharge_waived'
            and wt.lead_id = cl.id
        )
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
-- no grant changes to this function).
revoke all on function public.grant_referral_rewards(uuid) from public;
revoke all on function public.grant_referral_rewards(uuid) from anon;
revoke all on function public.grant_referral_rewards(uuid) from authenticated;
grant execute on function public.grant_referral_rewards(uuid) to service_role;


-- =============================================================================
-- FIX 2: public.messages - per-user send-rate limit
--
-- messages has never had a send-rate limit; 0086_message_length_limit.sql
-- added only a length CHECK on body, which bounds the size of a flood, not
-- its speed. A red-team run inserted 40 rows in 604ms directly through the
-- anon/authenticated PostgREST role - can_access_lead(lead_id) plus
-- sender_id = auth.uid() (0007) is the only gate on "messages insert", and
-- neither bounds request rate.
--
-- Mirrors 0087_med_security.sql's enforce_support_messages_rate_limit() /
-- enforce_reports_rate_limit() precedent exactly: a BEFORE INSERT trigger
-- function, SECURITY DEFINER so it can write public.rate_limits under its
-- owning role despite the inserting client's own (unprivileged) role, keyed
-- to a bucket derived from auth.uid(), using the same rate_limits
-- fixed-window upsert shape as rate_limit_hit() (0068) and both 0087
-- triggers. Deliberately its OWN bucket prefix ('messages_ins:'), not shared
-- with any other table's bucket, and its own function/trigger - separate from
-- 0087's messages_sender_role_guard (enforce_message_sender_role()), which
-- only derives sender_role and does not touch rate. Both BEFORE INSERT
-- triggers on public.messages run independently; this migration does not
-- modify that one.
--
-- Window is 60 seconds (not 0087's 3600s support/reports precedent) and the
-- cap is 30 messages per window: real chat use (a homeowner and a pro typing
-- back and forth) never comes close to 30 sends in a minute, but a tight
-- insert loop like the red-team's 40-in-604ms run hits it almost immediately.
-- =============================================================================
create or replace function public.enforce_messages_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_bucket text := 'messages_ins:' || coalesce(auth.uid()::text, 'anon');
  v_window timestamptz :=
    to_timestamp(floor(extract(epoch from now()) / 60) * 60);
  v_count int;
begin
  insert into public.rate_limits (bucket, window_start, count)
  values (v_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;
  -- 30/60s: well above any real human sending messages in a live chat, so
  -- this only ever bites a scripted flood like the red-team's 40-in-604ms
  -- run, never a normal conversation. See header for why 0086's length CHECK
  -- alone left this gap open.
  if v_count > 30 then
    raise exception 'Too many messages sent recently. Please slow down.';
  end if;
  return new;
end; $$;

drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit
  before insert on public.messages
  for each row execute function public.enforce_messages_rate_limit();


-- =============================================================================
-- FIX 3: is_active_member(uuid) - grant EXECUTE to anon
--
-- "properties member select" (0048_household_sharing.sql) is
-- `for select using (public.is_active_member(id))`. 0048 granted EXECUTE on
-- is_active_member(uuid) to authenticated only, never to anon. Since the
-- policy itself calls the function for EVERY select against properties
-- regardless of caller role, an anon SELECT makes Postgres try to evaluate a
-- function anon has no EXECUTE privilege on, which raises `42501 permission
-- denied for function is_active_member` instead of the policy simply
-- evaluating to false and returning zero rows (RLS's normal, silent
-- behavior for a non-matching caller).
--
-- Safe to grant: is_active_member(uuid) is SECURITY DEFINER, takes only a
-- property id, and its body (0048) is a single `select exists (...)` against
-- household_members keyed on auth.uid() - it returns a bare boolean and never
-- returns row data. An anon caller has no auth.uid(), so the function always
-- evaluates to false for them; this grant only lets that false be computed
-- without erroring, it does not open any new data access.
-- =============================================================================
grant execute on function public.is_active_member(uuid) to anon;


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. FIX 1 changes ONLY the two Shape B `exists()` blocks (marked "0089 fix"
--    above) inside grant_referral_rewards - every other line, including
--    Shape A, the sybil guard, the wallet locking order, and all four
--    once-per-* guards, is byte-for-byte identical to 0088's body. Dry-run:
--    reproduce the leak scenario (pro applies, gets ghost-refunded, the
--    homeowner picks them anyway via choose_applicant with the recharge
--    waived) against a copy of the deployed function and confirm
--    grant_referral_rewards now returns false for that referred contractor;
--    then confirm a genuine Shape B win (a directly rehired, actually-paid,
--    non-waived lead) still returns true and grants the reward.
--
-- 2. FIX 1 restates grant_referral_rewards(uuid)'s revoke/grant block
--    identically to 0088's, for the same reason: CREATE OR REPLACE with an
--    unchanged signature does not itself alter grants, and this keeps the
--    function's access (service_role only) explicit and self-verifying in
--    this file rather than relying on 0088 having run correctly.
--
-- 3. FIX 2's exact behavior to confirm on a dry run: a rapid loop of more
--    than 30 INSERTs into public.messages from the same auth.uid() within a
--    60-second window raises 'Too many messages sent recently. Please slow
--    down.' starting on the 31st insert of that window, while a normal
--    back-and-forth chat send (a handful of messages spread over minutes)
--    never raises. Also confirm 0087's messages_sender_role_guard still
--    fires independently and unmodified on the same inserts (both BEFORE
--    INSERT triggers coexist; trigger execution order between them is not
--    load-bearing since neither reads the other's effect on new.*).
--
-- 4. FIX 3 is cosmetic only: it changes an anon SELECT against properties
--    from a hard 42501 error to a clean empty result set. It does not grant
--    anon any new visibility into properties or household_members - the
--    owner-only/member-only row filtering in "properties owner all" and
--    "properties member select" is completely unchanged. Dry-run: confirm an
--    anon-key SELECT against public.properties no longer errors and returns
--    zero rows.
--
-- 5. FIX 1's ghost_recharge_waived / lead_id assumption on wallet_transactions
--    is the same one 0088 already verified against 0077_lock_contractor_leads.sql
--    (the waived branch's insert into wallet_transactions passes v_lead as
--    lead_id); FIX 2's rate_limits (bucket, window_start, count) shape and
--    FIX 3's is_active_member(uuid) signature were both confirmed here by
--    reading 0068_rate_limits.sql and 0048_household_sharing.sql directly.
--
-- 6. This migration was written and reasoned about, but NOT executed against
--    any database (per instructions). Dry-run against a staging copy of the
--    live schema before applying to production.
-- =============================================================================
