-- =============================================================================
-- Hearth - homeowner budget signal on job postings
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor), AFTER 0046.
--
-- Job posts are low-signal for pros: no budget indication means every quote is
-- a shot in the dark. This adds an OPTIONAL homeowner-selected budget band to
-- a posting, surfaced on the pro board's job cards so pros can price-judge
-- before paying the apply fee. It is a signal only, never a binding quote.
--
-- Two changes:
--
-- 1. contractor_leads.budget_range: the band the homeowner picked (or null).
--
-- 2. open_jobs_for_me() gains budget_range in its return set. The body is
--    otherwise IDENTICAL to 0046_locality_priority.sql's definition (the
--    newest on disk): 0028's live-spots application_count and has_photos
--    signal, plus 0046's state-level locality filter, plus_poster flag, and
--    Plus-first ordering, all preserved exactly. Return type changes, so drop
--    + recreate; CREATE re-grants EXECUTE to authenticated by default, which
--    0019 documents as intentional for this function (it derives the caller
--    from auth.uid()).
--
-- Safe to re-run.
-- =============================================================================

-- ---- Budget band on a posting -------------------------------------------------
alter table public.contractor_leads
  add column if not exists budget_range text;

comment on column public.contractor_leads.budget_range is
  'Homeowner-selected budget band for the posting: "under-500", "500-1500", '
  '"1500-5000", "5000-15000", "15000-plus", or "not-sure". A signal for pros '
  'to quote against, never a binding quote. Keep in sync with BUDGET_RANGES '
  'in src/lib/constants.ts.';

-- ---- open_jobs_for_me: 0046's definition + budget_range ------------------------
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
  plus_poster       boolean,
  budget_range      text
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
         cl.budget_range
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
