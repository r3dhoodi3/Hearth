-- =============================================================================
-- Hearth - state-level locality matching + Plus poster priority (0046)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Two job-board fixes, both scoped to open_jobs_for_me():
--
-- 1. LOCALITY (v1, state-level): until now the board had NO geography at all,
--    so a Phoenix pro could pay to apply to a Boston job while both sides'
--    copy said "local". contractors.service_state (two-letter code) is the
--    pro's declared service state, and the board only shows jobs whose
--    property is in that state. COLD-START SAFE by design: if the pro has no
--    service_state (every pre-0046 pro is grandfathered with null) OR the
--    property has no state on file, the job still shows. Locality must never
--    hide jobs from unconfigured data; full radius matching is deferred.
--
-- 2. PRIORITY (the sold Plus promise): the homeowner /plus page sells
--    "priority matching so pros see yours first", and no such ordering
--    existed anywhere in code. The board now returns plus_poster (true when
--    the property owner holds a live homeowner Hearth Plus subscription,
--    mirroring src/lib/subscription.ts liveness: homeowner-side plan, active
--    or trialing, period end unexpired) and orders by it first, so Plus
--    posters' jobs genuinely surface at the top of every matching pro's board.
--
-- Nothing else about the function changes: fee math, the 3-spot applicant
-- cap accounting, ghost-refund visibility, and category matching are exactly
-- 0028's. It remains SELECT-only. Return type changes, so drop + recreate;
-- CREATE re-grants EXECUTE to authenticated by default, which 0019 documents
-- as intentional for this function (it derives the caller from auth.uid()).
--
-- Safe to re-run.
-- =============================================================================

-- ---- Pro's service state ------------------------------------------------------
-- Two-letter state code (e.g. 'CA'), v1 of locality. Null = show everything,
-- which grandfathers every existing pro until they pick a state.
alter table public.contractors
  add column if not exists service_state text;

comment on column public.contractors.service_state is
  'Two-letter state code: state-level service area, v1 of locality. Null = show everything (grandfathers existing pros).';

-- ---- open_jobs_for_me: 0028's columns + locality filter + Plus priority --------
drop function if exists public.open_jobs_for_me();
create function public.open_jobs_for_me()
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
  plus_poster       boolean
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
         ) as plus_poster
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
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  -- PRIORITY: Plus posters' jobs first (the sold promise), newest first within
  -- each band. The pro board's default "new" sort keeps this DB order.
  order by plus_poster desc, cl.created_at desc;
$$;
