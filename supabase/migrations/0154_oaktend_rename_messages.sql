-- 0154: brand rename in DB-side user-visible text (Hearth -> OakTend).
--
-- The app is renamed OakTend (2026-09-03). Applied migrations are history and
-- are not edited; this migration re-creates the one function whose error text
-- reaches a user (the home-cap trigger from 0110) with the new brand name.
-- Everything else about the function is byte-for-byte the 0110 definition,
-- including the advisory-lock key 'hearth_home_cap', which is an internal
-- lock name and never shown to anyone. Safe to re-run.

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

  -- LIVE homeowner OakTend Plus, derived exactly as src/lib/subscription.ts
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
      raise exception 'Home limit reached: your OakTend Plus plan covers % homes. Add more from the Plus page.', v_cap
        using errcode = 'check_violation';
    else
      raise exception 'Home limit reached: free accounts can track 1 home. Upgrade to OakTend Plus for up to 5.'
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
