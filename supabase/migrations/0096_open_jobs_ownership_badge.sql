-- =============================================================================
-- Hearth - ownership-verified badge on the open job board (0094)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: migration 0093 added properties.ownership_status ('verified' when the
-- account holder's name matched the county assessor's recorded owner name for
-- the address, per src/lib/ownershipMatch.ts). Today that signal only gates
-- the email/SMS fan-out (src/lib/proAlerts.ts). This surfaces it to the pro
-- deciding whether to pay to apply: open_jobs_for_me() (latest body:
-- 0081_open_jobs_limit.sql) gains one new output column,
-- ownership_verified boolean, computed from the property it already
-- left-joins (pr.ownership_status = 'verified'), coalesced to false so a
-- job with no joined property (or an unverified one) reads as false, never
-- null.
--
-- SCOPE: open board only. The pro page's other job list - a pro's own
-- contractor_leads rows once assigned - is a direct table select the pro
-- reads under owner-only RLS and cannot join properties from the client, so
-- it has no ownership signal today and this migration does not touch it.
--
-- DROP + CREATE, not CREATE OR REPLACE: Postgres refuses to change a
-- function's OUT/RETURNS TABLE column set in place ("cannot change return
-- type of existing function"), so the column set change forces a drop first,
-- same as every prior open_jobs_for_me() column addition
-- (0028/0046/0047/0074). The body below is otherwise byte-for-byte 0081's -
-- same OC gate, same city column, same plus_poster subscription check, same
-- locality/category/application filters, same
-- `order by plus_poster desc, cl.created_at desc`, same `limit 200` - with
-- only the new column added to the select list and the returns table.
--
-- GRANTS: dropping a function drops its grants too, but open_jobs_for_me()
-- has never had an explicit grant or revoke statement in any migration - it
-- has always run on Postgres's default CREATE FUNCTION posture (EXECUTE to
-- PUBLIC, which authenticated inherits), which 0019_security_hardening.sql
-- explicitly documents as intentional for this function (it derives the
-- caller from auth.uid() via the contractors join, so an anon call just
-- returns nothing). 0028's drop+recreate made the same point ("CREATE
-- re-grants EXECUTE to authenticated by default"). Re-running CREATE FUNCTION
-- below reproduces that exact default posture with no extra grant/revoke
-- statements needed.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE FUNCTION. Safe to re-run.
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
  ownership_verified boolean
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
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified
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
