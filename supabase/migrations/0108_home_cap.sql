-- =============================================================================
-- Hearth - enforce the per-user home cap at the database (0107)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: the 1-free-home / 5-Plus-homes cap is enforced only in the onboarding
-- server action (src/app/onboarding/actions.ts, claimPropertyAction: free
-- owners get 1 home, Plus unlocks 5). That check runs in app code, but the
-- public anon key lets any signed-in user POST straight to
-- /rest/v1/properties. RLS ("properties owner insert", 0002) only checks
-- user_id = auth.uid(), so a technical user can create unlimited homes with
-- direct PostgREST calls and pocket the multi-home Plus perk without paying.
-- This closes the hole at the DB, the same way open jobs were capped
-- server-side (0081): a BEFORE INSERT trigger that counts and rejects.
--
-- WHAT: a BEFORE INSERT trigger on public.properties raises if the inserting
-- user already owns >= their cap. Cap is 5 when the user holds a LIVE
-- homeowner Hearth Plus subscription, else 1. "LIVE Plus" is derived inline
-- exactly as src/lib/subscription.ts hasPlus() does (isLive on the homeowner
-- side row): a homeowner-side subscriptions row (side = 'homeowner', or a plan
-- that is not a pro_ plan), status active or trialing, and not past a known
-- current_period_end. This is a byte-for-byte match of the plus_poster
-- predicate in 0081_open_jobs_limit.sql.
--
-- OWNED ROWS ONLY: the count is scoped to properties.user_id = NEW.user_id.
-- Homes merely SHARED with the user as a household member (0048) are separate
-- properties rows owned by a DIFFERENT user_id and surfaced to the member via
-- the "properties member select" RLS policy - they never carry the member's
-- user_id, so they can never wrongly consume the member's own cap. This
-- mirrors claimPropertyAction, which tallies only ownedHomes (!isShared).
--
-- DEFENSE IN DEPTH: the app-side check in claimPropertyAction stays in place
-- (it gives a friendly redirect to /plus); this trigger is the backstop for
-- any path that bypasses that action. Both must agree on the 1/5 thresholds.
--
-- RACE-SAFETY: a plain count in a BEFORE INSERT trigger is racy - two
-- concurrent inserts for the same user could each read N < cap and both land,
-- overshooting the cap. We take a per-user transaction-scoped advisory lock
-- (pg_advisory_xact_lock keyed on the user_id) BEFORE counting, so concurrent
-- inserts for the SAME user serialize: the second waits until the first
-- commits, then counts and sees the just-added row. The lock is keyed per
-- user, so inserts for different users never contend. It is released
-- automatically at end of transaction.
--
-- Idempotent: CREATE OR REPLACE for the function, DROP TRIGGER IF EXISTS +
-- CREATE for the trigger. Coexists with properties_ownership_locked (0093),
-- also a BEFORE INSERT trigger on this table; the two are independent (that
-- one neutralizes forged ownership columns, this one caps the row count).
-- Safe to re-run.
-- =============================================================================

create or replace function public.enforce_properties_home_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owned bigint;
  v_plus  boolean;
  v_cap   int;
begin
  -- Serialize concurrent inserts for THIS user (see RACE-SAFETY above). Keyed
  -- on the owner's user_id via the two-int form of pg_advisory_xact_lock, so
  -- only same-user inserts wait on each other.
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

  -- Free accounts: 1 home. Plus: up to 5 (landlord / multi-property owner).
  v_cap := case when v_plus then 5 else 1 end;

  -- Count only OWNED rows - homes shared with this user (0048) belong to a
  -- different user_id and are excluded automatically.
  select count(*) into v_owned
  from public.properties p
  where p.user_id = new.user_id;

  if v_owned >= v_cap then
    if v_plus then
      raise exception 'Home limit reached: Hearth Plus covers up to 5 homes.'
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
