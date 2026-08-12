-- =============================================================================
-- Hearth - cap open_jobs_for_me() + supporting index (0081)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- HIGH (DoS audit). open_jobs_for_me() (latest definition in
-- 0074_orange_county.sql) has no LIMIT, and the leads it scans
-- (contractor_leads where contractor_id is null and status = 'new') have no
-- supporting index - the planner falls back to a sequential scan filtered by
-- status/contractor_id. A backlog of stale/junk "new" leads (abandoned jobs,
-- spam submissions, anything that never got picked up) makes every pro
-- dashboard load scan and return the entire open-job backlog, degrading with
-- every additional junk lead. This is a byte-for-byte reproduction of
-- 0074_orange_county.sql's open_jobs_for_me() - same OC gate
-- (c.serves_orange_county = true), same city column, same plus_poster
-- subscription check, same locality/category/application filters, same
-- `order by plus_poster desc, cl.created_at desc` - with `limit 200` added
-- at the end. Signature (return columns) is unchanged, so CREATE OR REPLACE
-- is used instead of 0074's drop-then-create, preserving whatever grants are
-- already on the function.
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.open_jobs_for_me()
returns table (
  id                uuid,
  category          text,
  timing            text,
  issue_description text,
  issue_severity    text,
  payout_amount     numeric,
  created_at        timestamptz,
  application_count bigint,
  has_photos        boolean,
  plus_poster       boolean,
  budget_range      text,
  city              text
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
         -- plus_poster: the property owner holds a LIVE homeowner Hearth Plus
         -- subscription. Mirrors src/lib/subscription.ts (isLiveProPlanRow's
         -- homeowner inverse): homeowner-side row (side, or a plan that is not
         -- a pro_ plan), active or trialing, and not past a known period end.
         -- This implements the /plus "priority matching" promise.
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
         pr.city
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    and (c.categories is null or cl.category = any (c.categories))
    -- LOCALITY: state-level match, cold-start safe. A job is hidden ONLY when
    -- BOTH sides have a state and the states differ. A pro without a
    -- service_state (null = grandfathered) sees everything, and a property
    -- without a state on file is shown to everyone: never hide jobs from
    -- unconfigured data.
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    -- ORANGE COUNTY LAUNCH GATE: hard filter, not permissive like the state
    -- match above. A pro who hasn't explicitly confirmed they serve Orange
    -- County sees nothing here.
    and c.serves_orange_county = true
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  -- PRIORITY: Plus posters' jobs first (the sold promise), newest first within
  -- each band. The pro board's default "new" sort keeps this DB order.
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;

-- Supporting index (0081): matches open_jobs_for_me()'s
-- `contractor_id is null and status = 'new'` filter exactly, so the planner
-- can use it instead of a sequential scan over all of contractor_leads.
create index if not exists contractor_leads_open_idx
  on public.contractor_leads (created_at)
  where status = 'new' and contractor_id is null;
