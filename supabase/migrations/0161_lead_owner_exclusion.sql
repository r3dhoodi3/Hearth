-- 0161: SEC-1 - a dual-side account (homeowner AND pro on the same auth user)
-- can see, and pay to apply to, its OWN posted job. Reported in
-- fix-homeowner-flows-verify.md SEC-1 (2026-09-07 overnight wave): neither
-- open_jobs_for_me() nor apply_to_lead() ever compares the property owner to
-- auth.uid(). Harm is mostly confusion and a wasted wallet charge, not theft
-- (a pro pays themselves nothing of value), but it is the mechanism that put
-- pro pricing copy in front of someone who had just posted a job as a
-- homeowner (see the B5 report the same file names).
--
-- FIX: one owner-exclusion predicate in each function.
--   * open_jobs_for_me(): the job board itself must not list a self-posted
--     job. Added to the WHERE clause: `and pr.user_id is distinct from
--     auth.uid()`. `is distinct from` reads correctly even when pr.user_id
--     is null (a property row that failed to join) - it never hides a job
--     it shouldn't, it only ever hides the caller's own.
--   * apply_to_lead(): the charge path itself must refuse, not just the
--     board. Guard added immediately after `select pr.user_id into v_owner`
--     resolves (same line the 0138 block check and the 0060 relationship
--     check already key off of), before the block check, before any wallet
--     read, and before any row is written - so a refused self-apply moves no
--     money. Raises 'You cannot apply to your own job.', which
--     src/app/pro/actions.ts (applyToJobAction) matches on for a friendly
--     message; the SQL raise is the real enforcement (EXECUTE stays granted
--     to `authenticated`, so a signed-in pro can call apply_to_lead straight
--     over PostgREST with their own JWT, never touching that action - same
--     reasoning 0153's header gives for why its own gate has to live in SQL).
--
-- open_jobs_for_me(): DROP + CREATE, not CREATE OR REPLACE. This function's
-- RETURNS TABLE shape is unchanged here (same columns as 0155), but the
-- convention in this file is drop+create anyway - CREATE OR REPLACE only
-- works when the return type is byte-identical, and the next column this
-- function gains will need drop+create regardless (0096, 0104, 0116, 0155
-- all did). GRANTS: same posture as 0155 - open_jobs_for_me() has never had
-- an explicit grant or revoke; re-running CREATE FUNCTION reproduces the
-- default EXECUTE-to-PUBLIC posture (documented in 0019, re-stated in 0096
-- and 0155), so no grant statement is needed here.
--
-- apply_to_lead(): CREATE OR REPLACE. Signature (uuid, text) -> boolean is
-- unchanged, so this preserves its existing EXECUTE grant to `authenticated`
-- exactly as 0149 and 0153 both did for the same reason.
--
-- COPY-ONLY discipline, same as 0140/0141/0149/0153:
--   * open_jobs_for_me below is 0155's body (the latest in this folder,
--     migration 0155_lead_apply_homeowner_display.sql), byte-identical,
--     plus the one predicate above. Nothing else moved.
--   * apply_to_lead below is 0153's body (the latest in this folder,
--     migration 0153_major_job_insurance_gate.sql, Part 1), byte-identical,
--     plus the one guard block above. Nothing else moved.
--
-- DEPENDS ON 0155 (open_jobs_for_me with homeowner_display) and 0153
-- (apply_to_lead with the insurance gate). This is a TEMPORARY migration
-- number - Fable renumbers 0155-0160+ once tonight's collisions settle and
-- rebuilds supabase/PASTE-ME-ALL-PENDING-2026-09-07.sql; this file's
-- position in that rebuild must stay AFTER both 0155 and 0153.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE FUNCTION for
-- open_jobs_for_me, CREATE OR REPLACE for apply_to_lead. Safe to re-run.

-- ---- PRECHECK: refuse to run against a database that is not ready --------
do $precheck$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'open_jobs_for_me' and pronamespace = 'public'::regnamespace
      and prosrc like '%homeowner_display%'
  ) then
    raise exception 'PRECHECK: public.open_jobs_for_me() does not carry homeowner_display yet (migration 0155). Apply 0155 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace
      and prosrc like '%Insurance required for big jobs%'
  ) then
    raise exception 'PRECHECK: public.apply_to_lead() does not carry the big-job insurance gate yet (migration 0153). Apply 0153 before this file. Nothing was changed.';
  end if;
end;
$precheck$;

-- =============================================================================
-- Part 1: open_jobs_for_me() - 0155's body, plus the owner-exclusion predicate
-- =============================================================================
drop function if exists public.open_jobs_for_me();
create function public.open_jobs_for_me()
returns table (
  id                 uuid,
  category           text,
  timing             text,
  issue_description  text,
  issue_severity     text,
  payout_amount      numeric,
  created_at         timestamptz,
  application_count  bigint,
  has_photos         boolean,
  plus_poster        boolean,
  budget_range       text,
  city               text,
  ownership_verified boolean,
  photo_urls         text[],
  square_footage     integer,
  material_notes     text,
  has_plans_permits  boolean,
  homeowner_display  text
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
         exists (
           select 1
           from subscriptions s
           where s.user_id = pr.user_id
             and (s.side = 'homeowner'
                  or s.plan is null
                  or s.plan not like 'pro\_%' escape '\')
             and s.status in ('active', 'trialing')
             and (s.current_period_end is null or s.current_period_end > now())
         ) as plus_poster,
         cl.budget_range,
         pr.city,
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls,
         cl.square_footage,
         cl.material_notes,
         cl.has_plans_permits,
         -- First name + last initial only (C4): never the full name before a
         -- pro has applied and the homeowner has accepted them.
         case
           when cl.homeowner_name is null or btrim(cl.homeowner_name) = '' then null
           else (
             -- First name capped at 40 chars: homeowner_name has no length
             -- limit at the source (see the same cap in
             -- src/app/(app)/contractors/actions.ts), and this string is
             -- printed on a card, not a place for a 500-char "name".
             select case when array_length(parts, 1) > 1
                      then left(parts[1], 40) || ' '
                           || left(parts[array_length(parts, 1)], 1) || '.'
                      else left(parts[1], 40)
                    end
             from (select regexp_split_to_array(btrim(cl.homeowner_name), '\s+') as parts) s
           )
         end as homeowner_display
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    and cl.direct_to is null
    -- 0161 SEC-1: never list a job the caller posted as a homeowner. A dual-
    -- side account (a contractors row AND a properties row on the same auth
    -- user) must not see, apply to, or pay to apply to its own job. `is
    -- distinct from` reads correctly even when pr.user_id is null (a
    -- property that failed to join): it only ever excludes the caller's own
    -- row, never anyone else's.
    and pr.user_id is distinct from auth.uid()
    and (c.categories is null or cl.category = any (c.categories))
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    and c.serves_orange_county = true
    and public.launch_city_for_zip(pr.zip) = any (c.launch_cities)
    and not exists (
      select 1 from user_blocks b
      where (b.blocker_user_id = auth.uid() and b.blocked_user_id = pr.user_id)
         or (b.blocker_user_id = pr.user_id and b.blocked_user_id = auth.uid())
    )
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;

comment on function public.open_jobs_for_me() is
  'Open job board for the signed-in pro (0012, latest body 0161). 0161 adds '
  'the SEC-1 owner-exclusion predicate: a job whose property.user_id matches '
  'the caller (a dual-side account viewing its own posted job) is never '
  'listed. 0155''s homeowner_display column is unchanged.';

-- =============================================================================
-- Part 2: apply_to_lead - 0153's body, plus the SEC-1 self-apply guard
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
  -- pro's own OakTend Pro membership (10%) or the aging markdown, never both.
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

  -- 0161 SEC-1: a dual-side account (homeowner AND pro on the same auth user)
  -- must not be able to pay to apply to its own posted job. Placed
  -- immediately after v_owner resolves - the earliest point this function
  -- knows who the property owner is - and before the block check, before
  -- any wallet read, and before any row is written, so a refused self-apply
  -- moves no money. Raised text is matched by applyToJobAction in
  -- src/app/pro/actions.ts for a friendly message; this SQL raise is the
  -- real enforcement (see this file's header for why it must live here and
  -- not only in the server action).
  if v_owner is not null and v_owner = auth.uid() then
    raise exception 'You cannot apply to your own job.';
  end if;

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
  'Charges the lead fee and records an application (0012, latest body 0161). '
  '0153 added the big-job insurance gate; 0161 adds the SEC-1 self-apply '
  'guard: raises ''You cannot apply to your own job.'' when the resolved '
  'property owner (v_owner) equals auth.uid(), placed immediately after '
  'v_owner resolves and before any wallet read or write.';

-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- 1. The board excludes self-posted jobs.
--   select prosrc like '%pr.user_id is distinct from auth.uid()%'
--     from pg_proc
--    where proname = 'open_jobs_for_me' and pronamespace = 'public'::regnamespace;
--   -> t

-- 2. apply_to_lead carries the guard, with its exact raise text.
--   select prosrc like '%You cannot apply to your own job.%'
--     from pg_proc
--    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace;
--   -> t

-- 3. Both functions kept their grants (CREATE OR REPLACE preserves
--    apply_to_lead's; re-running CREATE FUNCTION on open_jobs_for_me
--    reproduces its always-been-default posture).
--   select routine_name, grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('open_jobs_for_me', 'apply_to_lead');
--   -> apply_to_lead includes authenticated | EXECUTE;
--      open_jobs_for_me includes PUBLIC | EXECUTE (or authenticated, which
--      inherits from PUBLIC - either is the unchanged default posture)

-- 4. Dry run, on a copy: as a dual-side account (a contractors row and a
--    properties row on the same auth user), post a job as the homeowner side,
--    then as the pro side call select public.open_jobs_for_me() - the job
--    must not appear. Then select public.apply_to_lead('<that lead id>', null)
--    - must raise 'You cannot apply to your own job.' and must not touch
--    wallets, lead_applications or wallet_transactions. A job posted by a
--    DIFFERENT homeowner must still appear on the board and apply normally.
