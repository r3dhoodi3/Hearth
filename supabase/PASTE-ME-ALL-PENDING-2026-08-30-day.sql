-- ============================================================================
-- HEARTH: ALL PENDING LIVE MIGRATIONS IN ONE PASTE (built 2026-08-30 afternoon)
-- Prerequisite: the morning bundle (PASTE-ME-ALL-PENDING-2026-08-30.sql,
-- 0141-0146 + storage caps) is already live. The PRECHECK below refuses to
-- run otherwise and changes nothing.
-- Supabase > SQL editor > new query > paste this whole file > Run.
-- Order: 0147 (repair reserve) -> 0148 (perf indexes) -> 0149 (Pro 10% lead
-- discount) -> 0150 (pin lead created_at, red team fix). One transaction: any failure applies nothing. Green "Success"
-- is the pass signal. Per-file verify queries stay in the three source files
-- named in the section headers.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contractors'
      and column_name = 'free_tool_drafts_used'
  ) then
    raise exception 'PRECHECK: contractors.free_tool_drafts_used (0145) is missing. Run PASTE-ME-ALL-PENDING-2026-08-30.sql (the morning bundle) first. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'blocked_between' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.blocked_between() (0138) is missing. Run the 2026-08-29 bundle first. Nothing was changed.';
  end if;
end
$$;


-- ############################################################################
-- SECTION: source supabase/PASTE-ME-live-2026-08-30-reserve.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0147 (2026-08-30)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: one nullable bigint column on public.properties,
-- repair_reserve_cents, plus a range CHECK and two column-level grants.
--
-- WHY: the cost forecast can already tell an owner "set aside about $210 a
-- month". Until this column exists it cannot tell them "and you are $60 a month
-- short", because nothing stores what they have actually put away. That second
-- sentence is what turns the forecast from an estimate into a plan.
--
-- Null means "the owner has not told us", which the app treats differently from
-- zero: null shows an invitation, zero shows how far behind they are. Nothing
-- is backfilled, so every existing home starts as "has not told us", which is
-- the truth.
--
-- Cents as bigint, matching every other money column in this schema. Per
-- PROPERTY, not per user: two homes have two timelines and two reserves.
--
-- ORDER: apply after 0146. It touches no function, view or policy that any
-- other pending migration owns, so it does not have to be interleaved with
-- anything.
--
-- NOTHING BREAKS IF YOU DELAY THIS. The forecast page reads this column in its
-- own small query that degrades to null on a missing-column error, and the save
-- action reports "could not save" instead of throwing. On a database that has
-- not run this file, the reserve card renders read-only and everything else on
-- the page works exactly as before. Nothing 500s.
--
-- NOT A SECURITY CHANGE. No RLS edit: this column lives under the same policies
-- address_line1 and market_value already have (the owner and their household,
-- nobody else). It is never sent to a contractor - every pro-facing read of a
-- home names its columns explicitly, so a new column is exposed nowhere on its
-- own. Worth being deliberate about: "how much cash this homeowner has set
-- aside" is exactly the fact a contractor should not be able to price against.
--
-- ABOUT THE TWO GRANTS AT THE BOTTOM: they are belt and braces, not a fix for a
-- live break. public.properties was deliberately never column-locked the way
-- public.contractors was in 0085 (0095 explains why: too many legitimate app
-- writers, and a wrong allowlist would break real saves), so this column is
-- already writable without them. They are here so that the day somebody DOES
-- column-lock properties, this column is on the allowlist instead of becoming
-- the next silent 42501 - the same half-applied shape 0124, 0128 and 0141 each
-- hit in turn.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0147_repair_reserve.sql >>>>>>>>>>

alter table public.properties
  add column if not exists repair_reserve_cents bigint;

comment on column public.properties.repair_reserve_cents is
  'What the owner says they have set aside toward the next big repair on this home, in cents. Null means they have not told us, which the forecast page treats differently from zero. Per property, not per user. Written only by saveRepairReserveAction (src/app/(app)/forecast/actions.ts), read only by the forecast page. Never exposed to a contractor.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.properties'::regclass
      and conname = 'properties_repair_reserve_cents_range'
  ) then
    alter table public.properties
      add constraint properties_repair_reserve_cents_range
      check (
        repair_reserve_cents is null
        or (repair_reserve_cents >= 0 and repair_reserve_cents <= 1000000000)
      ) not valid;
  end if;
end
$$;

alter table public.properties
  validate constraint properties_repair_reserve_cents_range;

grant insert (repair_reserve_cents) on public.properties to authenticated;
grant update (repair_reserve_cents) on public.properties to authenticated;

-- <<<<<<<<<< END 0147_repair_reserve.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY (run these after the block above; each should match the note)
-- ============================================================================

-- 1. The column exists, is bigint, and is nullable.
--    Expect exactly 1 row: repair_reserve_cents | bigint | YES
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'properties'
--    and column_name = 'repair_reserve_cents';

-- 2. Nothing was backfilled: every existing home is still "has not told us".
--    Expect with_a_value = 0 right after applying.
-- select count(*) as total,
--        count(repair_reserve_cents) as with_a_value
--   from public.properties;

-- 3. The constraint exists AND is validated. Expect one row ending in `t`;
--    an `f` means the validate step did not run and old rows were not checked.
-- select conname, convalidated
--   from pg_constraint
--  where conrelid = 'public.properties'::regclass
--    and conname = 'properties_repair_reserve_cents_range';

-- 4. `authenticated` holds INSERT and UPDATE on the column. Expect two rows.
-- select privilege_type
--   from information_schema.column_privileges
--  where table_schema = 'public'
--    and table_name = 'properties'
--    and column_name = 'repair_reserve_cents'
--    and grantee = 'authenticated'
--  order by privilege_type;

-- 5. RLS is still on and no new policy appeared. Expect properties | true, and
--    the same policy list as before.
-- select relname, relrowsecurity from pg_class where relname = 'properties';
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'properties'
--  order by policyname;

-- 6. The check really bites. Both of these must ERROR. Run them inside a
--    transaction you roll back, against a property uuid you actually own, so
--    nothing real is touched.
-- begin;
--   update public.properties set repair_reserve_cents = -1
--    where id = '<a property uuid you own>';
-- rollback;
--
-- begin;
--   update public.properties set repair_reserve_cents = 1000000001
--    where id = '<a property uuid you own>';
-- rollback;

-- 7. A legitimate value saves. 450000 cents is $4,500.00.
-- begin;
--   update public.properties set repair_reserve_cents = 450000
--    where id = '<a property uuid you own>';
--   select repair_reserve_cents from public.properties
--    where id = '<a property uuid you own>';
-- rollback;

-- 8. End to end, after the deploy: open /forecast as a Hearth Plus member,
--    type an amount into "What you have saved so far", save, and confirm the
--    row moved. Replace the address.
-- select address_line1, repair_reserve_cents
--   from public.properties
--  where address_line1 = '123 Your St';

-- 9. To clear your own figure again (back to "has not told us", not zero):
-- update public.properties
--    set repair_reserve_cents = null
--  where address_line1 = '123 Your St';


-- ############################################################################
-- SECTION: source supabase/PASTE-ME-live-2026-08-30-perf-indexes.sql
-- ############################################################################

-- PASTE ME into the Supabase SQL editor (Dashboard > SQL Editor > New query),
-- then press Run. This is the live twin of
-- supabase/migrations/0148_perf_indexes.sql.
--
-- Safe to run more than once: every statement is `create index if not exists`.
-- Nothing here adds or removes a table, column, function, policy or grant, so
-- nobody's access changes. It only gives Postgres a cheaper way to answer
-- lookups it already answers on every signed-in page load.
--
-- Order does not matter and there is nothing to run before it. Takes a second
-- or two on today's data.

create index if not exists contractor_leads_contractor_created_idx
  on public.contractor_leads (contractor_id, created_at desc);

create index if not exists contractor_leads_property_created_idx
  on public.contractor_leads (property_id, created_at desc);

create index if not exists lead_applications_contractor_created_idx
  on public.lead_applications (contractor_id, created_at desc);

create index if not exists reviews_contractor_created_idx
  on public.reviews (contractor_id, created_at desc);

create index if not exists documents_property_uploaded_idx
  on public.documents (property_id, uploaded_at desc);

create index if not exists issues_property_status_created_idx
  on public.issues (property_id, status, created_at desc);

create index if not exists maintenance_tasks_property_due_idx
  on public.maintenance_tasks (property_id, due_date);

create index if not exists home_systems_property_created_idx
  on public.home_systems (property_id, created_at);

create index if not exists photos_related_uploaded_idx
  on public.photos (related_type, related_id, uploaded_at);

-- ---------------------------------------------------------------------------
-- VERIFY. Run this after the statements above. It should return 9 rows, one
-- per index name below. Fewer rows means one did not get created: re-run the
-- block above and read the error message.
-- ---------------------------------------------------------------------------
select indexname, tablename
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'contractor_leads_contractor_created_idx',
    'contractor_leads_property_created_idx',
    'lead_applications_contractor_created_idx',
    'reviews_contractor_created_idx',
    'documents_property_uploaded_idx',
    'issues_property_status_created_idx',
    'maintenance_tasks_property_due_idx',
    'home_systems_property_created_idx',
    'photos_related_uploaded_idx'
  )
order by tablename, indexname;

-- ---------------------------------------------------------------------------
-- OPTIONAL second check: prove Postgres is actually using one of them. Swap
-- the id for a real contractor id. The plan should name
-- contractor_leads_contractor_created_idx and should NOT contain a "Sort"
-- node above the scan.
-- ---------------------------------------------------------------------------
-- explain analyze
-- select id, homeowner_name, category, property_address, created_at
-- from public.contractor_leads
-- where contractor_id = '00000000-0000-0000-0000-000000000000'
-- order by created_at desc
-- limit 500;


-- ############################################################################
-- SECTION: source supabase/PASTE-ME-live-2026-08-30-pro-lead-discount.sql
-- ############################################################################

-- =============================================================================
-- PASTE-ME (2026-08-30): Hearth Pro members get 10% off every lead fee,
-- never stacked with the aging markdown. Twin of
-- supabase/migrations/0149_pro_lead_discount.sql - identical body, this
-- banner only.
--
-- Prerequisite: everything through migration 0148 is already live (the
-- PRECHECK block below refuses to run and changes nothing if it isn't).
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE. Safe
-- to re-run: every statement is idempotent (CREATE OR REPLACE, ADD COLUMN IF
-- NOT EXISTS, a guarded ADD CONSTRAINT). No CONCURRENTLY anywhere, so this is
-- safe to run inside the editor's single transaction.
--
-- OWNER'S WORDS: "for pro paid, if they buy it they start off with a 10%
-- discount for leads. It does NOT stack with the 15-30%. More incentive to
-- buy."
--
-- WHAT THIS CHANGES
--
-- 1. Three new pure helper functions:
--      is_pro_member(uuid)               - mirrors isLiveProPlanRow() in
--                                           src/lib/subscription.ts: a pro_
--                                           plan, active or trialing, not
--                                           past a known period end.
--      lead_aging_pct(timestamptz)       - the same 15%-at-3-days /
--                                           30%-at-7-days tiers
--                                           lead_fee_cents() (0031) already
--                                           charges, expressed as a bare
--                                           percent so it can be compared
--                                           against the member percent.
--      pro_lead_fee_cents(numeric,
--        timestamptz, boolean)           - the fee a lead actually costs:
--                                           the BASE price marked down by
--                                           whichever is bigger, the aging
--                                           tier or the flat 10% Pro member
--                                           discount. greatest() picks the
--                                           bigger percent, so the two never
--                                           add together - a member on a
--                                           7-day-old lead still only gets
--                                           30% off, not 40%.
--
-- 2. apply_to_lead is re-created with the pricing block swapped: it used to
--    price a lead with lead_fee_cents(payout_amount, created_at) (aging
--    only); it now prices with pro_lead_fee_cents(payout_amount, created_at,
--    is_pro_member(auth.uid())). The one-time first-big-ticket intro price
--    (major_lead_price_cents, 0113) is UNCHANGED and still runs after this:
--    it is a fixed price and takes over only when it undercuts whatever this
--    step computed, so a member's first big-ticket lead is never discounted
--    below the intro price - the intro is a floor, not something else to
--    stack a percent onto. EVERY OTHER GUARD IN THE FUNCTION IS VERBATIM:
--    the chargeback freeze, the Orange County gate, the applicant cap, the
--    block gate (0138), the one-live-lead-per-relationship rule, the launch
--    city gate, the wallet lock and FIFO bonus drain. Diff this function
--    against 0138's Part 5 - the only differences are the pricing block
--    right after the job is selected, the discount_kind assignment beside
--    the intro-price line, and discount_kind riding along on the insert.
--
-- 3. lead_applications gains a nullable discount_kind text column (CHECK'd to
--    'member' / 'aging' / 'intro' / null), so the wallet ledger and any
--    future receipt can say WHICH discount priced a given application - never
--    inferred after the fact from fee_cents alone, which cannot tell a 10%
--    member discount apart from an unlucky round number. unlock_direct_request
--    (0104) is NOT touched by this migration, so a direct-request unlock never
--    writes a discount_kind (stays null) - membership does not discount that
--    path today. No column-level grant needed: every write to
--    lead_applications happens inside a SECURITY DEFINER function, which
--    writes with the function owner's privileges, not the caller's (same
--    reasoning fee_cents itself has never needed one).
--
-- KEEP IN SYNC: src/lib/constants.ts's PRO_LEAD_DISCOUNT_PCT (10) and
-- src/lib/leadPricing.ts's bestLeadDiscount(), which the TS side uses to
-- preview this exact same math before a pro ever taps Apply, and
-- src/lib/subscription.ts's isLiveProPlanRow(), which is_pro_member mirrors.
--
-- RACE SAFETY: unchanged from 0113/0138. Every one of a pro's charges still
-- serializes on the wallet row FOR UPDATE, and the pricing block above runs
-- BEFORE that lock is taken - same position lead_fee_cents ran in before this
-- migration - so it carries no new race: two concurrent applies for the same
-- pro still each price independently and then serialize on the actual debit.
--
-- Idempotent throughout (CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS, a
-- guarded ADD CONSTRAINT). Safe to re-run. apply_to_lead's signature is
-- unchanged, so CREATE OR REPLACE preserves its existing EXECUTE grant to
-- `authenticated`.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that isn't caught up -------
-- This migration re-creates apply_to_lead in full (not a delta), so it does
-- not itself depend on 0138 having run - but it DOES call functions and read
-- a table that earlier migrations create, and a database missing any of them
-- would fail apply_to_lead with a confusing "function does not exist" the
-- next time a pro tries to apply, instead of a clear message right here.
do $$
declare n int;
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'blocked_between' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.blocked_between() is missing. Apply migrations through 0138 (user_blocks) before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'major_lead_price_cents' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.major_lead_price_cents() is missing. Apply migration 0115 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'plan'
  ) then
    raise exception 'PRECHECK: public.subscriptions.plan is missing. Apply the base subscriptions migration before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contractor_leads' and column_name = 'payout_amount'
  ) then
    raise exception 'PRECHECK: public.contractor_leads.payout_amount is missing. Apply migrations through 0012 before this file. Nothing was changed.';
  end if;
  select count(*) into n from pg_proc
    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace;
  if n = 0 then
    raise exception 'PRECHECK: public.apply_to_lead() does not exist yet. Apply migrations through 0138 before this file. Nothing was changed.';
  end if;
end
$$;

-- =============================================================================
-- Part 1: pricing helpers
-- =============================================================================

-- Mirrors isLiveProPlanRow() in src/lib/subscription.ts byte for byte: a pro_
-- plan (the 'pro\_' prefix is the same escaped LIKE the block gate's
-- plus_poster query in 0138 and public_pro_profile in 0141 already use),
-- active or trialing, and not past a known period end.
create or replace function public.is_pro_member(p_user uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.user_id = p_user
      and s.plan like 'pro\_%' escape '\'
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

revoke all on function public.is_pro_member(uuid) from public;
revoke all on function public.is_pro_member(uuid) from anon;
revoke all on function public.is_pro_member(uuid) from authenticated;

-- The aging markdown from lead_fee_cents (0031), restated as a bare percent
-- instead of baking it into a cents calculation, so apply_to_lead can compare
-- it against the flat member percent and take the bigger one. Keep these two
-- tiers in sync with lead_fee_cents's own case statement and with
-- AGING_LEAD_TIERS in src/lib/leadPricing.ts - all three must agree.
create or replace function public.lead_aging_pct(p_created timestamptz)
returns int language sql stable set search_path = public as $$
  select case
    when p_created is null then 0
    when now() - p_created >= interval '7 days' then 30
    when now() - p_created >= interval '3 days' then 15
    else 0
  end;
$$;

revoke all on function public.lead_aging_pct(timestamptz) from public;
revoke all on function public.lead_aging_pct(timestamptz) from anon;
revoke all on function public.lead_aging_pct(timestamptz) from authenticated;

-- The fee a lead actually costs before the one-time major-tier intro price
-- (applied separately, see apply_to_lead below): the base payout marked down
-- by the BIGGER of the aging tier and the flat 10% Pro member discount,
-- never both added together. greatest() is the whole rule - a member on a
-- fresh lead pays base*0.90, a non-member on a 7-day-old lead pays
-- base*0.70, and a member on that same 7-day-old lead ALSO pays base*0.70
-- (30 > 10), not base*0.60. Keep the literal 10 in sync with
-- PRO_LEAD_DISCOUNT_PCT in src/lib/constants.ts.
create or replace function public.pro_lead_fee_cents(
  p_payout numeric, p_created timestamptz, p_is_member boolean
) returns bigint language sql stable set search_path = public as $$
  select greatest(0, round(
    coalesce(p_payout, 0) * 100 * (
      100 - greatest(
        public.lead_aging_pct(p_created),
        case when p_is_member then 10 else 0 end
      )
    ) / 100.0
  ))::bigint;
$$;

revoke all on function public.pro_lead_fee_cents(numeric, timestamptz, boolean) from public;
revoke all on function public.pro_lead_fee_cents(numeric, timestamptz, boolean) from anon;
revoke all on function public.pro_lead_fee_cents(numeric, timestamptz, boolean) from authenticated;

-- =============================================================================
-- Part 2: lead_applications.discount_kind
-- =============================================================================

alter table public.lead_applications
  add column if not exists discount_kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lead_applications'::regclass
      and conname = 'lead_applications_discount_kind_known'
  ) then
    alter table public.lead_applications
      add constraint lead_applications_discount_kind_known
      check (discount_kind is null or discount_kind in ('member', 'aging', 'intro'))
      not valid;
  end if;
end
$$;

alter table public.lead_applications validate constraint lead_applications_discount_kind_known;

comment on column public.lead_applications.discount_kind is
  'Which single discount priced this application (mirrors fee_cents): '
  '''member'' (Hearth Pro, 10% off, never stacked), ''aging'' (the '
  'unclaimed-listing markdown), ''intro'' (the fixed first-big-ticket-lead '
  'price), or null for no discount. Written only by apply_to_lead (0149); '
  'unlock_direct_request (0104) does not set it and always leaves it null.';

-- =============================================================================
-- Part 3: apply_to_lead - 0138's body, plus the member-discount pricing
-- =============================================================================
-- COPY-ONLY, same discipline 0138 and 0141 used: 0138 is the latest
-- definition of apply_to_lead in this folder. Diff this against 0138's Part 5
-- - the only differences are (a) the select now also reads payout_amount and
-- created_at instead of pre-computing the price with lead_fee_cents, (b) the
-- new pricing block right after "Job not found", (c) the discount_kind
-- assignment beside the existing intro-price line, and (d) discount_kind on
-- the insert. Every guard, every raise, every order of operations is
-- untouched: the chargeback freeze, the Orange County gate, the applicant
-- cap, the 0138 block gate, the one-live-lead-per-relationship rule, the
-- launch city gate, the wallet FOR UPDATE lock, and the FIFO bonus drain.
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
begin
  perform set_config('hearth.lead_write', 'on', true);

  select id, categories, serves_orange_county, launch_cities
    into v_contractor, v_cats, v_oc, v_launch_cities
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

-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- 1. The three helpers exist and price a sample lead as expected: a fresh
--    (today) $99 major-tier lead for a non-member is $99.00 (9900 cents), for
--    a member is $89.10 (8910 cents, 10% off); a 7-day-old $99 lead is
--    $69.30 for BOTH a member and a non-member (30% aging beats 10% member,
--    never stacked).
--   select public.pro_lead_fee_cents(99, now(), false);              -> 9900
--   select public.pro_lead_fee_cents(99, now(), true);                -> 8910
--   select public.pro_lead_fee_cents(99, now() - interval '8 days', false); -> 6930
--   select public.pro_lead_fee_cents(99, now() - interval '8 days', true);  -> 6930

-- 2. discount_kind exists with the right constraint.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'lead_applications'
--      and column_name = 'discount_kind';
--   -> one row: discount_kind | text | YES
--   select conname, convalidated
--     from pg_constraint
--    where conrelid = 'public.lead_applications'::regclass
--      and conname = 'lead_applications_discount_kind_known';
--   -> one row: lead_applications_discount_kind_known | t

-- 3. apply_to_lead's body carries the member predicate and the never-stack
--    rule (the same substrings src/lib/leadPricing.test.ts's SQL source test
--    checks for).
--   select prosrc from pg_proc
--    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace;
--   -> contains "public.is_pro_member(auth.uid())" and
--      "greatest(" (inside pro_lead_fee_cents) and "v_discount_kind"

-- 4. The function still has its EXECUTE grant to authenticated (CREATE OR
--    REPLACE with an unchanged signature preserves it, this just confirms).
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'apply_to_lead';
--   -> includes authenticated | EXECUTE


-- ############################################################################
-- SECTION: source supabase/PASTE-ME-live-2026-08-30-pin-lead-created-at.sql (0150, red team H1)
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB PASTE: migration 0150 (2026-08-30)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE, after
-- the 0147-0149 bundle. Safe to re-run.
-- PRECHECK: refuses to run if the lock trigger function is missing.
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'enforce_contractor_leads_locked' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.enforce_contractor_leads_locked() is missing. Apply migrations through 0131 first. Nothing was changed.';
  end if;
end
$$;

-- =============================================================================
-- Hearth - pin contractor_leads.created_at (0150)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Apply after 0149.
--
-- WHY THIS EXISTS (red team H1, 2026-08-30, proven on live)
--
-- The homeowner who posted a lead holds full UPDATE on their own row through
-- RLS policy "contractor_leads owner all" (0002), and the lock trigger
-- enforce_contractor_leads_locked() pins property_id, issue_id, direct_to,
-- payout_amount, paid, status and the homeowner fields, but never created_at.
-- Meanwhile apply_to_lead prices the lead fee from that column: 15% off after
-- 3 days, 30% off after 7 (lead_aging_pct, 0149; lead_fee_cents before it).
-- So a homeowner, or a dual-side account, or a pro who talks a homeowner into
-- it, could run one plain update that sets created_at nine days into the past
-- and buy the lead at the maximum markdown on the day it was posted. Hearth
-- loses up to 30% of the fee on every such apply, and because the aging
-- markdown always beats the 10% member discount, membership no longer matters
-- for pricing that lead.
--
-- WHAT THIS CHANGES
--
-- One function, re-issued byte-for-byte from 0131 with two added lines:
--   INSERT (unprivileged): created_at := now(), so a back-dated insert is
--     impossible too (the column defaults to now(); this closes the explicit
--     override).
--   UPDATE (unprivileged, depth <= 1): created_at := old.created_at, in the
--     same block that already pins property_id and issue_id.
-- The privileged path (hearth.lead_write = on, set only inside the SECURITY
-- DEFINER RPCs) is untouched, and no RPC writes created_at anyway. No app code
-- writes created_at on contractor_leads (checked: nothing in src does), so
-- nothing legitimate changes.
--
-- No RLS change, no grant change, no new column. Idempotent: create or
-- replace. The trigger binding from 0121/0131 stays as it is; only the
-- function body changes.
-- =============================================================================

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
    -- ---- 0131 addition: issue_id must belong to this lead's own property ---
    -- "contractor_leads owner all" (0002) checks property_id and nothing else,
    -- so without this a raw PostgREST insert attaches another homeowner's
    -- issue to a lead on a property this account owns. open_jobs_for_me
    -- aggregates photo_urls by issue_id, and can_view_job_photo_full binds a
    -- signed url to the lead through it, so that forgery republishes the other
    -- home's photo keys and unlocks them full resolution.
    if new.issue_id is not null
       and not exists (
         select 1
           from public.issues i
          where i.id = new.issue_id
            and i.property_id = new.property_id
       )
    then
      new.issue_id := null;
    end if;
    -- ---- end 0131 addition ------------------------------------------------

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
      -- 0150: the posting time is money (the aging markdown prices off it),
      -- so a caller cannot back-date a brand new lead either.
      new.created_at := now();
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

      -- ---- 0117 addition: pin the lead to its property, issue and target ---
      -- A lead's chat thread, its notifications, and the job photos a paid pro
      -- can see are all resolved through property_id / issue_id. Re-pointing
      -- either one moves a live lead into another homeowner's account. No
      -- application path ever updates them, so a flat revert is correct.
      new.property_id := old.property_id;
      new.issue_id    := old.issue_id;
      -- 0150: created_at is pinned like property_id. See the header.
      new.created_at  := old.created_at;

      -- direct_to: revert every change EXCEPT the one legitimate transition,
      -- a homeowner clearing an already-set target on a still-unassigned lead
      -- so it becomes a plain public job (postDirectRequestAsJobAction). A
      -- flat revert would break that feature silently. Setting direct_to from
      -- null, or swapping it to a different pro, is always reverted: that is
      -- the actual hole, since the target pro gets a private unlock path into
      -- the lead.
      -- Nested rather than one flat AND chain on purpose: PostgreSQL does not
      -- promise left-to-right short-circuiting inside a single boolean
      -- expression, so a flat version could call owns_property() on EVERY
      -- non-privileged lead UPDATE, including the ones that never mention
      -- direct_to. The outer IF makes that impossible.
      if new.direct_to is distinct from old.direct_to then
        if not (
          old.direct_to is not null
          and new.direct_to is null
          and old.contractor_id is null
          and coalesce(public.owns_property(old.property_id), false)
        ) then
          new.direct_to := old.direct_to;
        end if;
      end if;
      -- ---- end 0117 addition ------------------------------------------------

      -- ---- 0119 addition: block the assigned pro from rewriting homeowner
      --      identity and job detail --------------------------------------
      -- The pro's UPDATE policy ("leads contractor update", 0005) re-checks
      -- only contractor_id, so without this the assigned pro could rewrite the
      -- homeowner's name/email/phone (name is shown to the homeowner and on the
      -- review share card - spoofable), the property address, and the job
      -- detail fields on the lead they were assigned. The owner writes these
      -- legitimately through updateJobAction / closeJobAction; the pro must
      -- not. owns_property(old.property_id) is TRUE for the homeowner and any
      -- household member (they reach this row via "contractor_leads owner all",
      -- 0002) and FALSE for the pro (who reaches it via the contractor policy),
      -- so it is the exact owner-vs-pro discriminator. SECURITY INVOKER, and
      -- owns_property is granted to authenticated (0048) and service_role
      -- (0118), so the call resolves for whichever role is writing.
      --
      -- Same nested shape as the direct_to block above, and for the same
      -- reason: the outer IF fires only when one of the protected columns
      -- actually changed, so owns_property() is never evaluated on the pro's
      -- ordinary status-only write (updateLeadStatusAction, the pro's ONLY
      -- legitimate non-privileged write), nor on any update that leaves these
      -- columns alone.
      --
      -- payout_amount is intentionally absent here: category is reverted for
      -- the non-owner, and 0117's recompute block just below derives
      -- payout_amount from the final category, so a pro-forged category and/or
      -- payout_amount still lands on the base fee for the ORIGINAL category
      -- without this block touching the money logic. This runs BEFORE that
      -- recompute so the recompute sees the reverted category.
      if new.homeowner_name    is distinct from old.homeowner_name
         or new.homeowner_email  is distinct from old.homeowner_email
         or new.homeowner_phone  is distinct from old.homeowner_phone
         or new.property_address is distinct from old.property_address
         or new.issue_description is distinct from old.issue_description
         or new.issue_severity   is distinct from old.issue_severity
         or new.budget_range     is distinct from old.budget_range
         or new.timing           is distinct from old.timing
         or new.square_footage   is distinct from old.square_footage
         or new.material_notes   is distinct from old.material_notes
         or new.has_plans_permits is distinct from old.has_plans_permits
         or new.category         is distinct from old.category
         or new.owner_closed_at  is distinct from old.owner_closed_at then
        if not coalesce(public.owns_property(old.property_id), false) then
          new.homeowner_name    := old.homeowner_name;
          new.homeowner_email   := old.homeowner_email;
          new.homeowner_phone   := old.homeowner_phone;
          new.property_address  := old.property_address;
          new.issue_description := old.issue_description;
          new.issue_severity    := old.issue_severity;
          new.budget_range      := old.budget_range;
          new.timing            := old.timing;
          new.square_footage    := old.square_footage;
          new.material_notes    := old.material_notes;
          new.has_plans_permits := old.has_plans_permits;
          new.category          := old.category;
          new.owner_closed_at   := old.owner_closed_at;
        end if;
      end if;
      -- ---- end 0119 addition ------------------------------------------------

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

-- =============================================================================
-- VERIFY (run after applying)
-- =============================================================================
-- 1. The function body carries both pins.
--   select position('new.created_at  := old.created_at' in pg_get_functiondef('public.enforce_contractor_leads_locked'::regproc)) > 0 as update_pinned,
--          position('new.created_at := now()' in pg_get_functiondef('public.enforce_contractor_leads_locked'::regproc)) > 0 as insert_pinned;
--   -> true | true
-- 2. As a homeowner (RLS client), inside a transaction you roll back:
--   begin;
--     update public.contractor_leads set created_at = now() - interval '9 days'
--      where id = '<a lead you own>';
--     select created_at from public.contractor_leads where id = '<same id>';
--     -- expect: the ORIGINAL timestamp, unchanged
--   rollback;
