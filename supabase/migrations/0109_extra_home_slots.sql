-- =============================================================================
-- Hearth - paid extra-home slots + cap that counts them (0108)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. This depends on 0107
-- (the home-cap trigger) - apply 0107 first if it hasn't been applied yet.
--
-- WHY: Plus members can now buy extra homes beyond the 5 Plus includes (the
-- pay-per-extra-home add-on, a second Stripe subscription item). The Stripe
-- webhook records the purchased quantity on the subscription row; the home cap
-- must count those bought slots on top of the base allowance, at the DB, so the
-- same direct-PostgREST bypass 0107 closes can't dodge the paid limit either.
--
-- WHAT:
--   1. subscriptions.extra_home_slots int not null default 0 - the number of
--      paid extra homes on that subscription. Written by the webhook from the
--      add-on item's quantity; 0 when there is no add-on or Plus is canceled.
--   2. CREATE OR REPLACE enforce_properties_home_cap so the cap becomes
--         (5 if LIVE Plus else 1) + coalesce(live homeowner row's slots, 0)
--      Slots are counted ONLY from a LIVE homeowner-side subscription row (the
--      same side + status + period predicate 0107 already uses for the "Plus"
--      test), so a lapsed subscription's stale slot value never grants extra
--      capacity - slots lapse with Plus. A free (non-Plus) account has no live
--      homeowner row, so its slot sum is 0 and its cap stays 1.
--
-- The advisory lock, the owned-rows-only count, and the INSERT-only gating are
-- kept EXACTLY as 0107 has them: existing homes are never touched, only NEW
-- inserts past the cap are rejected. This mirrors the app-side formula in
-- src/app/onboarding/actions.ts (claimPropertyAction): cap = plus ? 5 + slots
-- : 1. Both must agree.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE for the function,
-- DROP TRIGGER IF EXISTS + CREATE for the trigger. Safe to re-run.
-- =============================================================================

alter table public.subscriptions
  add column if not exists extra_home_slots int not null default 0;

create or replace function public.enforce_properties_home_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owned bigint;
  v_plus  boolean;
  v_extra int;
  v_cap   int;
begin
  -- Serialize concurrent inserts for THIS user (see 0107's RACE-SAFETY note).
  -- Keyed on the owner's user_id, so only same-user inserts wait on each other.
  perform pg_advisory_xact_lock(hashtext('hearth_home_cap'), hashtext(new.user_id::text));

  -- LIVE homeowner Hearth Plus, derived exactly as src/lib/subscription.ts
  -- hasPlus() does and identically to 0081's plus_poster: a homeowner-side row
  -- (side = 'homeowner', or a plan that is not a pro_ plan), active or
  -- trialing, and not past a known period end.
  v_plus := exists (
    select 1
    from public.subscriptions s
    where s.user_id = new.user_id
      and (s.side = 'homeowner'
           or s.plan is null
           or s.plan not like 'pro\_%' escape '\')
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );

  -- Paid extra-home slots, summed over the SAME live homeowner-side row(s). A
  -- non-Plus account has no live homeowner row here, so this is 0 and its cap
  -- stays 1. There is at most one homeowner row per user, but sum() keeps this
  -- correct regardless.
  select coalesce(sum(s.extra_home_slots), 0) into v_extra
  from public.subscriptions s
  where s.user_id = new.user_id
    and (s.side = 'homeowner'
         or s.plan is null
         or s.plan not like 'pro\_%' escape '\')
    and s.status in ('active', 'trialing')
    and (s.current_period_end is null or s.current_period_end > now());

  -- Free accounts: 1 home. Plus: 5 (landlord / multi-property owner) plus any
  -- paid extra-home slots.
  v_cap := (case when v_plus then 5 else 1 end) + coalesce(v_extra, 0);

  -- Count only OWNED rows - homes shared with this user (0048) belong to a
  -- different user_id and are excluded automatically.
  select count(*) into v_owned
  from public.properties p
  where p.user_id = new.user_id;

  if v_owned >= v_cap then
    if v_plus then
      raise exception 'Home limit reached: your Hearth Plus plan covers % homes. Add more from the Plus page.', v_cap
        using errcode = 'check_violation';
    else
      raise exception 'Home limit reached: free accounts can track 1 home. Upgrade to Hearth Plus for up to 5.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists properties_home_cap on public.properties;
create trigger properties_home_cap
  before insert on public.properties
  for each row execute function public.enforce_properties_home_cap();
