-- =============================================================================
-- Hearth - job photos for pros on the open board (0103)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: today a pro deciding whether to pay to apply sees only a boolean
-- "Photos attached" chip (open_jobs_for_me.has_photos) and can never view the
-- actual homeowner job photos - not before applying, not even after being
-- chosen. The photos live in the PRIVATE home-photos bucket and the photos
-- table is RLS-locked to the property owner, so no pro read path exists. This
-- migration adds:
--   1. one new output column photo_urls on open_jobs_for_me() - the stored
--      urls of the same issue photos has_photos already checks - so the board
--      can render a downscaled preview strip;
--   2. can_preview_job_photo() - true when the caller is a board-eligible pro
--      for the lead AND the given photo url really belongs to that lead's
--      issue photos (the binding stops a pro pairing an arbitrary object path
--      with a lead they can see);
--   3. can_view_job_photo_full() - same photo-belongs-to-lead binding, plus
--      the caller is the property owner, the assigned contractor, or a pro who
--      already PAID to apply (a lead_applications row), gating full-resolution.
-- The serving route (src/app/api/job-photo) calls these SECURITY DEFINER
-- functions with the caller's session, then signs a short-lived URL via the
-- admin client ONLY when the function returns true.
--
-- DROP + CREATE for open_jobs_for_me(): Postgres refuses to change a
-- function's RETURNS TABLE column set in place, so adding photo_urls forces a
-- drop first, same as every prior column addition (0028/0046/0047/0074/0094).
-- The body below is otherwise byte-for-byte 0094's - same OC gate, same city
-- column, same ownership_verified column, same plus_poster subscription check,
-- same locality/category/application filters, same
-- `order by plus_poster desc, cl.created_at desc`, same `limit 200` - with
-- only photo_urls added to the select list and the returns table. Grants: the
-- function has always run on the default CREATE FUNCTION posture (EXECUTE to
-- PUBLIC, which authenticated inherits) documented in 0019/0094; re-running
-- CREATE reproduces that with no extra grant statement.
--
-- The photos table orders by uploaded_at (there is no created_at column on it),
-- so photo_urls is aggregated in upload order.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE, and CREATE OR REPLACE for the
-- two boolean gates. Safe to re-run.
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
  photo_urls         text[]
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
         pr.city,
         -- ownership_verified (0094): the account name matched the county
         -- assessor's recorded owner for this address (migration 0093).
         -- coalesce keeps this null-safe when the left join finds no
         -- property, or when the property is on file but unverified.
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         -- photo_urls (0103): the stored urls of the same issue photos
         -- has_photos checks (related_type='issue', related_id=cl.issue_id),
         -- upload order. array_agg over no rows yields NULL, so a job with no
         -- photos reads as null here. The serving route re-checks each url
         -- against the lead via can_preview_job_photo before signing.
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls
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

-- -----------------------------------------------------------------------------
-- can_preview_job_photo(lead, photo url): may the caller see a DOWNSCALED
-- preview of this photo, pre-application? True only when BOTH hold:
--   (i)  the caller's contractor row makes this lead board-eligible - the exact
--        same predicate as open_jobs_for_me's WHERE (unassigned, status 'new',
--        category match, state match, serves_orange_county). The "not already
--        applied" clause is deliberately omitted: an applied pro just uses full
--        mode, and should still be allowed the preview.
--   (ii) the url actually belongs to that lead's issue photos. This binding
--        prevents a pro pairing an arbitrary object path with a lead they can
--        see to fish for photos from other properties.
-- -----------------------------------------------------------------------------
create or replace function public.can_preview_job_photo(
  p_lead_id uuid,
  p_photo_url text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from contractor_leads cl
      join contractors c on c.user_id = auth.uid()
      left join properties pr on pr.id = cl.property_id
      where cl.id = p_lead_id
        and cl.contractor_id is null
        and cl.status = 'new'
        and (c.categories is null or cl.category = any (c.categories))
        and (c.service_state is null
             or pr.state is null
             or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
        and c.serves_orange_county = true
    )
    and exists (
      select 1
      from photos p
      join contractor_leads cl on cl.issue_id = p.related_id
      where cl.id = p_lead_id
        and p.related_type = 'issue'
        and p.url = p_photo_url
    );
$$;

-- -----------------------------------------------------------------------------
-- can_view_job_photo_full(lead, photo url): may the caller see the
-- FULL-RESOLUTION photo? True only when the same photo-belongs-to-lead binding
-- holds AND the caller is entitled to full res: the property owner, the
-- assigned contractor, or a pro who already PAID to apply (a lead_applications
-- row for this lead). Mirrors can_access_lead (0007) for the owner/assigned
-- checks, adding the applied-pro case.
-- -----------------------------------------------------------------------------
create or replace function public.can_view_job_photo_full(
  p_lead_id uuid,
  p_photo_url text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from photos p
      join contractor_leads cl on cl.issue_id = p.related_id
      where cl.id = p_lead_id
        and p.related_type = 'issue'
        and p.url = p_photo_url
    )
    and exists (
      select 1
      from contractor_leads cl
      where cl.id = p_lead_id
        and (
          public.owns_property(cl.property_id)
          or cl.contractor_id in (
            select id from contractors where user_id = auth.uid()
          )
          or exists (
            select 1
            from lead_applications la
            join contractors c on c.id = la.contractor_id
            where la.lead_id = cl.id
              and c.user_id = auth.uid()
          )
        )
    );
$$;

grant execute on function public.can_preview_job_photo(uuid, text) to authenticated;
grant execute on function public.can_view_job_photo_full(uuid, text) to authenticated;
