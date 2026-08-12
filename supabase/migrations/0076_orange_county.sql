-- Orange County, CA launch restriction (0074). RUN AGAINST LIVE DB, AFTER 0073.
--
-- Hearth is launching in Orange County, CA only. Three changes:
--
-- 1. contractors.serves_orange_county: a pro must explicitly confirm they
--    serve Orange County before they can see or apply to jobs. Defaults to
--    false so every existing pro is opted OUT until they confirm (see
--    src/app/pro/actions.ts saveCompanyAction) - a hard gate, not a soft
--    preference like service_state.
--
-- 2. market_waitlist: a pro or homeowner outside the launch area lands here
--    instead of getting an account, so Hearth can reach out when it opens in
--    their area. Insert-only from the client (anon covers the homeowner
--    landing-page form, which runs before sign-in); no select policy, so the
--    table is admin-read only.
--
-- 3. open_jobs_for_me(): identical to 0047_job_budget.sql's definition
--    (budget_range preserved), plus (a) the property city in the return set
--    and (b) a hard `c.serves_orange_county = true` filter. Unlike the
--    service_state locality match, this is NOT permissive: a pro who hasn't
--    confirmed Orange County sees nothing, full stop.
--
-- Safe to re-run.
-- =============================================================================

-- ---- Orange County opt-in on the contractor row -------------------------------
alter table public.contractors
  add column if not exists serves_orange_county boolean not null default false;

comment on column public.contractors.serves_orange_county is
  'Pro explicitly confirmed they serve Orange County, CA (Hearth''s launch '
  'market). Hard gate on open_jobs_for_me() and applyToJobAction - defaults '
  'false, so every pro (new or existing) must opt in before they see or '
  'apply to jobs.';

-- ---- Market waitlist -----------------------------------------------------------
create table if not exists public.market_waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  role       text not null check (role in ('homeowner', 'pro')),
  zip        text,
  state      text,
  created_at timestamptz not null default now()
);

create unique index if not exists market_waitlist_email_role_uidx
  on public.market_waitlist (lower(email), role);

alter table public.market_waitlist enable row level security;

-- Insert-only, from anon (pre-sign-in homeowner landing form) and
-- authenticated (a pro rejected at onboarding). No select policy: reading
-- the waitlist is admin-only, via the service-role client.
drop policy if exists "market_waitlist insert" on public.market_waitlist;
create policy "market_waitlist insert" on public.market_waitlist
  for insert to anon, authenticated with check (true);

-- ---- open_jobs_for_me: 0047's definition + city + Orange County gate -----------
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
  order by plus_poster desc, cl.created_at desc;
$$;
