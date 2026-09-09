-- 0155: applying to a lead currently shows nothing about who is posting it
-- until after the homeowner accepts. Tester feedback C4 (2026-09-07): show a
-- first name + last initial (e.g. "Sarah M.") on the open-job card BEFORE a
-- pro applies, so they know who they're applying to, without exposing
-- anything more. Full contact info still only unlocks after acceptance
-- (contractor_leads.homeowner_name / homeowner_email / homeowner_phone, read
-- only off the ASSIGNED_* columns in src/app/pro/leads/page.tsx).
--
-- open_jobs_for_me() (0138's latest body) never selected homeowner_name at
-- all. This is COPY-ONLY of that body plus one new computed column: the raw
-- full name never crosses the wire pre-application, only the truncated
-- display string computed here.
--
-- DROP + CREATE, not CREATE OR REPLACE: adding a column to a RETURNS TABLE
-- changes the function's return type, and Postgres refuses that on a replace
-- ("cannot change return type of existing function", 42P13). Every prior
-- column addition to this function did the same (0096, 0104, 0116).
--
-- GRANTS: dropping a function drops its grants, but open_jobs_for_me() has
-- never had an explicit grant or revoke in any migration. It runs on the
-- default CREATE FUNCTION posture (EXECUTE to PUBLIC, which authenticated
-- inherits), documented as deliberate in 0019 and re-stated in 0096: the
-- body derives the caller from auth.uid() through the contractors join, so
-- an anon call returns nothing. Re-running CREATE FUNCTION reproduces that
-- exact posture, so no grant statement is needed here either.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE FUNCTION. Safe to re-run.

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
  photo_urls         text[],
  square_footage     integer,
  material_notes     text,
  has_plans_permits  boolean,
  homeowner_display  text
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
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
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls,
         cl.square_footage,
         cl.material_notes,
         cl.has_plans_permits,
         -- First name + last initial only (C4): never the full name before a
         -- pro has applied and the homeowner has accepted them.
         case
           when cl.homeowner_name is null or btrim(cl.homeowner_name) = '' then null
           else (
             -- First name capped at 40 chars: homeowner_name has no length
             -- limit at the source (see the same cap in
             -- src/app/(app)/contractors/actions.ts), and this string is
             -- printed on a card, not a place for a 500-char "name".
             select case when array_length(parts, 1) > 1
                      then left(parts[1], 40) || ' '
                           || left(parts[array_length(parts, 1)], 1) || '.'
                      else left(parts[1], 40)
                    end
             from (select regexp_split_to_array(btrim(cl.homeowner_name), '\s+') as parts) s
           )
         end as homeowner_display
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    and cl.direct_to is null
    and (c.categories is null or cl.category = any (c.categories))
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    and c.serves_orange_county = true
    and public.launch_city_for_zip(pr.zip) = any (c.launch_cities)
    and not exists (
      select 1 from user_blocks b
      where (b.blocker_user_id = auth.uid() and b.blocked_user_id = pr.user_id)
         or (b.blocker_user_id = pr.user_id and b.blocked_user_id = auth.uid())
    )
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;
