-- =============================================================================
-- Hearth - big-job insurance gate (0153)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- OWNER DECISION (2026-08-30): before a pro can take a BIG job, they must have
-- proof of insurance on file. "Big job" is the major lead tier - the same
-- three categories major_lead_price_cents (0113) prices at LEAD_TIER_FEES.major:
-- roof, structural, remodeling. "On file" is the existing compliance calendar
-- (migration 0051): contractors.insurance_expires, set when the pro uploads a
-- certificate of insurance on /pro/business (or types the date by hand), must
-- hold a date that has not passed. Light/skilled-tier leads stay ungated.
--
-- WHY SQL AND NOT JUST THE SERVER ACTION: both charge paths keep EXECUTE for
-- `authenticated` (0119 deliberately left every pre-0117 function's grant in
-- place, and 0149's VERIFY confirms apply_to_lead's), so any signed-in pro can
-- call apply_to_lead / unlock_direct_request straight over PostgREST with
-- their own JWT, never touching src/app/pro/actions.ts. The actions carry the
-- same gate for a friendly early refusal; THIS is the enforcement.
--
-- WHAT CHANGES: both charge functions are re-created with one added gate that
-- raises 'Insurance required for big jobs' for a major-tier lead when the
-- caller's contractors.insurance_expires is null or in the past. KEEP IN SYNC:
-- the category list mirrors LEAD_FEES in src/lib/constants.ts and
-- major_lead_price_cents (0113); the predicate mirrors hasCurrentInsurance()
-- in src/lib/insuranceGate.ts (ok/expiring pass, none/expired fail); the raise
-- text mirrors INSURANCE_GATE_SQL_ERROR there, which is what the actions match
-- on to show the friendly message.
--
-- PLACEMENT, deliberate in both bodies:
--   * AFTER each function's idempotent already-paid return, so a pro who
--     already holds the lead keeps getting the honest `true` on a retry even
--     if their insurance has since lapsed - same reasoning 0124 used for the
--     launch-city gate.
--   * BEFORE any wallet read, any debit, and any row written: a refused apply
--     or unlock costs nothing and changes nothing.
--
-- COPY-ONLY discipline, same as 0140/0141/0149:
--   * apply_to_lead below is 0149's Part 3 body (the latest in this folder)
--     plus (a) insurance_expires added to the existing contractors select and
--     (b) the one gate block marked "0153". Nothing else moved.
--   * unlock_direct_request below is 0140's Part 1 body (the latest in this
--     folder) plus the same two deltas. Nothing else moved.
-- Unchanged signatures, so CREATE OR REPLACE preserves both functions'
-- existing EXECUTE grants.
--
-- Idempotent: CREATE OR REPLACE throughout. Safe to re-run.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that is not ready -----------
-- Everything this file re-creates leans on earlier migrations. Raising here
-- (inside a DO block, before either CREATE) means a wrong-order paste changes
-- NOTHING instead of replacing a live charge function with a body that
-- references missing objects.
do $precheck$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.apply_to_lead() does not exist yet. Apply migrations through 0151 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'unlock_direct_request' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.unlock_direct_request() does not exist yet. Apply migrations through 0151 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'pro_lead_fee_cents' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.pro_lead_fee_cents() (migration 0149) is missing. Apply 0149 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'blocked_between' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.blocked_between() (migration 0138) is missing. Apply 0138/0140 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contractors'
      and column_name = 'insurance_expires'
  ) then
    raise exception 'PRECHECK: contractors.insurance_expires (migration 0051) is missing. Apply 0051 before this file. Nothing was changed.';
  end if;
end;
$precheck$;

-- =============================================================================
-- Part 1: apply_to_lead - 0149's body, plus the big-job insurance gate
-- =============================================================================
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[]; v_oc boolean;
  v_launch_cities text[]; v_lead_city text;
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
  v_property uuid; v_owner uuid;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
  -- 0149: raw job age/price inputs, this pro's membership, and the pricing
  -- verdict recorded on the application row.
  v_payout numeric; v_created timestamptz;
  v_is_member boolean; v_aging_pct int; v_member_pct int;
  v_discount_kind text; v_price_before_intro bigint;
  -- 0153: this pro's insurance expiry (compliance calendar, 0051), for the
  -- big-job gate below.
  v_insurance_expires date;
begin
  perform set_config('hearth.lead_write', 'on', true);

  -- 0153: insurance_expires rides the contractors select this function
  -- already makes, so the gate costs no extra query.
  select id, categories, serves_orange_county, launch_cities, insurance_expires
    into v_contractor, v_cats, v_oc, v_launch_cities, v_insurance_expires
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- 0132: an open payment dispute freezes spending. has_open_chargeback() is
  -- true only while this pro's account carries an uncleared abuse_flags row of
  -- kind 'chargeback' (written by the Stripe webhook on
  -- charge.dispute.created). Placed here, immediately after the contractor
  -- resolves and BEFORE the job is read, before any wallet lock, and before a
  -- single cent moves: a pro who has charged back a wallet top-up is spending
  -- money the platform has already lost, and the wallet balance still says it
  -- is there. Cleared by setting abuse_flags.cleared_at (service role only), so
  -- a dispute that is won or withdrawn unfreezes the account without erasing
  -- that it happened.
  if public.has_open_chargeback(v_contractor) then
    raise exception 'There is an unresolved payment dispute on your account. Contact support.';
  end if;

  -- 0087 fix (MED): reproduce open_jobs_for_me()'s hard Orange County launch
  -- gate here too, so a pro who never confirmed serves_orange_county can't
  -- bypass the board by applying directly against a leaked/guessed lead id.
  if not coalesce(v_oc, false) then
    raise exception 'Confirm the cities you serve in your profile before applying to jobs';
  end if;

  -- 0149: read the raw price inputs instead of pre-pricing with
  -- lead_fee_cents (aging only) here - the pricing block right below needs
  -- this pro's membership too, and FOR UPDATE still serializes concurrent
  -- applies to the same job so the applicant cap below can't be raced past 3.
  select contractor_id, status, category, property_id, payout_amount, created_at
    into v_lead_contractor, v_status, v_category, v_property, v_payout, v_created
    from contractor_leads where id = p_lead
    for update;
  if v_category is null then raise exception 'Job not found'; end if;

  -- 0149: price this lead with the best SINGLE discount available - this
  -- pro's own Hearth Pro membership (10%) or the aging markdown, never both.
  -- is_pro_member mirrors isLiveProPlanRow() in src/lib/subscription.ts;
  -- lead_aging_pct is the same tiers lead_fee_cents (0031) already charges,
  -- as a bare percent. discount_kind is recorded on the application row
  -- below so the receipt and the board can both say what actually happened;
  -- ties (both 0) record null, and the flat member percent can never
  -- literally tie a nonzero aging tier at today's numbers, but the >=
  -- comparison keeps aging as the deterministic winner if it ever does.
  v_is_member := public.is_pro_member(auth.uid());
  v_aging_pct := public.lead_aging_pct(v_created);
  v_member_pct := case when v_is_member then 10 else 0 end;
  if v_aging_pct = 0 and v_member_pct = 0 then
    v_discount_kind := null;
  elsif v_aging_pct >= v_member_pct then
    v_discount_kind := 'aging';
  else
    v_discount_kind := 'member';
  end if;
  v_price := public.pro_lead_fee_cents(v_payout, v_created, v_is_member);

  if v_lead_contractor is not null then return false; end if;  -- already assigned
  if v_status <> 'new' then return false; end if;              -- not open
  if v_cats is not null and not (v_category = any (v_cats)) then
    raise exception 'Job is not in your categories';
  end if;
  if exists (
    select 1 from lead_applications
    where lead_id = p_lead and contractor_id = v_contractor
  ) then
    return true;  -- idempotent: already applied
  end if;

  -- 0153: big jobs need current insurance on file. The three categories are
  -- the major tier (mirror LEAD_FEES in src/lib/constants.ts and
  -- major_lead_price_cents, 0113); the date rule mirrors hasCurrentInsurance
  -- in src/lib/insuranceGate.ts (a date today or later passes, nothing on
  -- file or a past date fails). Deliberately AFTER the idempotent
  -- already-applied return above - a pro who already paid for this lead keeps
  -- the honest `true` on a retry even if their insurance lapsed since (same
  -- reasoning as 0124's launch-city gate placement) - and BEFORE any wallet
  -- read or write, so a refused apply moves no money. The raise text is what
  -- applyToJobAction matches on (isInsuranceGateSqlError) to show the
  -- friendly message; keep it stable.
  if v_category in ('roof', 'structural', 'remodeling')
     and (v_insurance_expires is null or v_insurance_expires < current_date) then
    raise exception 'Insurance required for big jobs';
  end if;

  -- 0124: the per-city half of the launch gate, mirroring the identical line
  -- open_jobs_for_me() filters the board on. Deliberately AFTER the
  -- already-applied idempotent return above: a pro who paid for this lead and
  -- later narrowed their launch_cities still gets the honest `true` on a
  -- retry, never a geography error for a job they already hold. Still before
  -- any money moves or any row is written.
  select public.launch_city_for_zip(p.zip) into v_lead_city
    from properties p where p.id = v_property;
  if v_lead_city is null or not (v_lead_city = any (coalesce(v_launch_cities, '{}'))) then
    raise exception 'This job is outside the cities you serve. Update your service area in your profile.';
  end if;

  -- One live lead per relationship (0060's rule): refuse when the pro already
  -- has an active job (not closed/lost) in this category on a property with
  -- the same owner. Closed/lost jobs never block, so rehires and repeat
  -- business stay wide open.
  select pr.user_id into v_owner from properties pr where pr.id = v_property;

  -- 0138: a block between these two people. Symmetric, and worded without
  -- saying which side blocked whom - the pro must not be able to use this
  -- error to learn that a particular homeowner blocked them. Placed on the
  -- first line that knows who the homeowner is, and still before every wallet
  -- read, every debit, and every insert.
  if v_owner is not null and public.blocked_between(auth.uid(), v_owner) then
    raise exception 'This job is not available to you.';
  end if;

  if v_owner is not null and exists (
    select 1
    from contractor_leads active
    join properties ap on ap.id = active.property_id
    where active.contractor_id = v_contractor
      and active.category = v_category
      and active.status not in ('closed', 'lost')
      and ap.user_id = v_owner
  ) then
    raise exception 'Already working with this homeowner';
  end if;

  -- Applicant cap: 3 live (non-refunded) applications fill a job. Keep in sync
  -- with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065 fix: FOR UPDATE so a concurrent charge against this same wallet
  -- (a different lead, or a ghost recharge) can't read a stale balance and
  -- push cash/bonus negative. See migration header for the race.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price. Deliberately placed AFTER the
  -- wallet FOR UPDATE above: all of a pro's charges serialize on that lock,
  -- so two racing major applies can never both read "no prior major payment"
  -- (see 0113's header). No-op for non-major categories and for any pro who
  -- has ever paid for a major lead.
  --
  -- 0149: the intro price is fixed and never further discounted by the
  -- member/aging pricing above - least() inside major_lead_price_cents just
  -- takes whichever is lower, so it can only ever push the charge DOWN to
  -- 4999, never below it. When it does undercut the member/aging price,
  -- discount_kind flips to 'intro' so the receipt names the real reason,
  -- not the discount it overrode.
  v_price_before_intro := v_price;
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);
  if v_price < v_price_before_intro then
    v_discount_kind := 'intro';
  end if;

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail.
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: prompt a deposit
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

  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents, discount_kind)
    values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price, v_discount_kind);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'apply_fee', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Applied to job');

  return true;
end; $$;

comment on function public.apply_to_lead(uuid, text) is
  'Charges the lead fee and records an application (0012, latest body 0153). '
  '0153 adds the big-job insurance gate: a major-tier lead (roof, structural, '
  'remodeling) raises ''Insurance required for big jobs'' unless the caller''s '
  'contractors.insurance_expires is today or later. Placed after the '
  'idempotent already-applied return and before any wallet read or write.';

-- =============================================================================
-- Part 2: unlock_direct_request - 0140's body, plus the big-job insurance gate
-- =============================================================================
create or replace function public.unlock_direct_request(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_direct_to uuid; v_lead_contractor uuid; v_status text; v_category text;
  v_declined timestamptz; v_unlocked timestamptz; v_price bigint;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
  -- 0153: this pro's insurance expiry (compliance calendar, 0051), for the
  -- big-job gate below.
  v_insurance_expires date;
begin
  -- Privileged flag: the contractor_leads_locked trigger (0077, latest body
  -- 0088) strips any client write to contractor_id/paid/paid_at/status unless
  -- this session flag is set, exactly as apply_to_lead/choose_applicant do
  -- (0087). Without it, the final assignment UPDATE below would be silently
  -- reverted after the wallet was already debited. Must be the FIRST statement.
  perform set_config('hearth.lead_write', 'on', true);

  -- 0153: insurance_expires rides the contractors select this function
  -- already makes, so the gate costs no extra query.
  select id, insurance_expires into v_contractor, v_insurance_expires
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- 0132: an open payment dispute freezes spending. has_open_chargeback() is
  -- true only while this pro's account carries an uncleared abuse_flags row of
  -- kind 'chargeback' (written by the Stripe webhook on
  -- charge.dispute.created). Placed here, immediately after the contractor
  -- resolves and BEFORE the job is read, before any wallet lock, and before a
  -- single cent moves: a pro who has charged back a wallet top-up is spending
  -- money the platform has already lost, and the wallet balance still says it
  -- is there. Cleared by setting abuse_flags.cleared_at (service role only), so
  -- a dispute that is won or withdrawn unfreezes the account without erasing
  -- that it happened.
  if public.has_open_chargeback(v_contractor) then
    raise exception 'There is an unresolved payment dispute on your account. Contact support.';
  end if;

  -- Lock the lead and price the fee from its age, same as apply_to_lead.
  -- 0113: category is read too, so the intro price below can tell whether
  -- this is a major-tier request.
  select direct_to, contractor_id, status, category,
         direct_declined_at, direct_unlocked_at,
         public.lead_fee_cents(payout_amount, created_at)
    into v_direct_to, v_lead_contractor, v_status, v_category,
         v_declined, v_unlocked, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_direct_to is null then raise exception 'Not a direct request'; end if;
  if v_direct_to <> v_contractor then raise exception 'Not your request'; end if;

  -- Already unlocked: by me -> idempotent success; otherwise impossible.
  if v_lead_contractor is not null then
    if v_lead_contractor = v_contractor then return true; end if;
    raise exception 'Request already assigned';
  end if;
  if v_declined is not null then raise exception 'Request was declined'; end if;
  if v_status <> 'new' then raise exception 'Request no longer available'; end if;

  -- 0153: big jobs need current insurance on file, same gate and same raise
  -- text as apply_to_lead's (see Part 1 for the full reasoning). Placed after
  -- the idempotent already-unlocked return above - a pro who already paid for
  -- this request keeps the honest `true` on a retry - and before the block
  -- check, the wallet, and every write, so a refused unlock moves no money.
  if v_category in ('roof', 'structural', 'remodeling')
     and (v_insurance_expires is null or v_insurance_expires < current_date) then
    raise exception 'Insurance required for big jobs';
  end if;

  -- 0140: a block between these two people. Same predicate as apply_to_lead's
  -- gate (0138), same wording, same reason: symmetric, and it must not tell
  -- the pro which side blocked whom. This is the third and last place a pro
  -- spends wallet money - the job board (open_jobs_for_me) and apply_to_lead
  -- were closed in 0138; this was the one left open. Placed after every
  -- existing "is this request even available" check and before
  -- get_or_create_wallet, so it costs nothing extra and still refuses before
  -- any wallet is touched.
  if exists (
    select 1
    from contractor_leads l
    join properties pr on pr.id = l.property_id
    where l.id = p_lead
      and public.blocked_between(auth.uid(), pr.user_id)
  ) then
    raise exception 'This job is not available to you.';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065/0087 hardening: FOR UPDATE so a concurrent charge against this same
  -- wallet (a different lead, an apply, a ghost recharge) can't read a stale
  -- balance and push cash/bonus negative.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price, after the wallet lock for the
  -- same serialization reason as apply_to_lead (see 0113's header).
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail after the
  -- lead was already treated as unlockable (0087).
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: prompt a deposit
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
    if v_remaining > 0 then return false; end if;  -- safety
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- History row for the paid unlock (also the row ghost_refund_direct marks).
  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, null, 'chosen', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'direct_unlock', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Direct request unlocked');

  -- Assign + open chat: contractor_id set is what unlocks contact and messages.
  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now(), direct_unlocked_at = now()
   where id = p_lead;

  return true;
end; $$;

comment on function public.unlock_direct_request(uuid) is
  'Pays to unlock and assign a direct request (0105, latest body 0153). 0153 '
  'adds the big-job insurance gate: a major-tier request (roof, structural, '
  'remodeling) raises ''Insurance required for big jobs'' unless the caller''s '
  'contractors.insurance_expires is today or later. Placed after the '
  'idempotent already-unlocked return and before any wallet read or write.';

-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- 1. Both bodies carry the gate, with its exact raise text.
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('apply_to_lead', 'unlock_direct_request')
--      and prosrc like '%Insurance required for big jobs%';
--   -> exactly two rows: apply_to_lead, unlock_direct_request

-- 2. The gate reads the right column: both bodies mention insurance_expires
--    and the major category list.
--   select proname
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('apply_to_lead', 'unlock_direct_request')
--      and prosrc like '%v_insurance_expires%'
--      and prosrc like '%''roof'', ''structural'', ''remodeling''%';
--   -> exactly two rows

-- 3. Both functions kept their EXECUTE grants (CREATE OR REPLACE with an
--    unchanged signature preserves them; this just confirms).
--   select routine_name, grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('apply_to_lead', 'unlock_direct_request');
--   -> each includes authenticated | EXECUTE

-- 4. Dry run, on a copy: as a pro whose contractors.insurance_expires is null,
--    select public.apply_to_lead('<open roof lead id>', null) must raise
--    'Insurance required for big jobs' and must not touch wallets,
--    lead_applications or wallet_transactions. Set that pro's
--    insurance_expires to current_date and the same call proceeds (charging
--    as before). A 'cleaning' lead must charge normally with insurance_expires
--    still null.
