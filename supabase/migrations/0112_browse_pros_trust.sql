-- =============================================================================
-- Hearth - trust upgrades for the browse-pros card (0111)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- The homeowner "browse pros" card (src/app/(app)/contractors/browse) currently
-- shows less trust signal than the pro's own public page (/p/<id>). This
-- migration closes that gap by redefining browse_pros(text) to also return:
--
--   * has_insurance          - same derivation public_pro_profile uses since
--                              0109: insurance_carrier is present and non-blank.
--                              Self-reported, so the UI shows it as a neutral
--                              gray "Insurance on file" chip, never green.
--   * yelp_url,
--     google_reviews_url     - the optional outbound review-page links from
--                              0110, exposed here with the same policy: plain
--                              links only, free for every pro, never gated on
--                              membership. 0110 deliberately left these off the
--                              browse card; that call is reversed here.
--   * latest_review_comment,
--     latest_review_rating   - the newest review that has a non-empty comment
--                              for the contractor (null when none). Reviews are
--                              already public via public_pro_profile (up to 100
--                              full comments), so surfacing one snippet here
--                              exposes nothing new. Reviewer stays anonymous:
--                              no author fields leave the database.
--   * photo_urls             - up to 3 project photo URLs, preferring "after"
--                              shots (is_before = false) first, then newest
--                              first. Photos already appear ungated on the
--                              public page (0045/0109); URLs point at the
--                              public pro-logos bucket. Empty array when none.
--   * created_at             - contractors.created_at, for a small
--                              "On Hearth since YYYY" footer. Already public
--                              via public_pro_profile.
--
-- SAFE-PUBLIC-FIELDS RULE (unchanged from 0104/0109): still no contact info,
-- no license numbers, no insurance carrier names, no status text, no private
-- jsonb. Every added field is either already exposed by public_pro_profile or
-- derived the same way it derives them.
--
-- Everything else - the Orange County launch gate, the category filter, the
-- member gate on logo_url, rating math, ordering, the 200-row limit - is
-- byte-identical to 0109's body.
--
-- NOTE: the return type changes, so CREATE OR REPLACE cannot be used; the
-- function is dropped and recreated (grants re-issued below). Idempotent:
-- drop if exists + create. Safe to re-run.
-- =============================================================================

drop function if exists public.browse_pros(text);

create function public.browse_pros(p_category text default null)
returns table (
  id                    uuid,
  slug                  text,
  name                  text,
  categories            text[],
  rating                numeric,
  review_count          int,
  has_license           boolean,
  has_insurance         boolean,
  license_verified_at   timestamptz,
  background_checked_at timestamptz,
  logo_url              text,
  service_area          text,
  project_count         bigint,
  yelp_url              text,
  google_reviews_url    text,
  latest_review_comment text,
  latest_review_rating  int,
  photo_urls            text[],
  created_at            timestamptz
) language sql security definer stable set search_path = public as $$
  select
    c.id,
    c.slug,
    c.name,
    coalesce(c.categories, '{}') as categories,
    case when c.review_count > 0 then c.rating end as rating,
    c.review_count,
    -- Trust signals: FREE for every pro (0109). Not gated on m.live.
    (c.license_number is not null
      and btrim(c.license_number) <> '') as has_license,
    -- Same derivation public_pro_profile has used since 0109. Only the
    -- boolean leaves the database, never the carrier or policy details.
    (c.insurance_carrier is not null
      and btrim(c.insurance_carrier) <> '') as has_insurance,
    c.license_verified_at,
    c.background_checked_at,
    -- Cosmetic: still a member perk, still gated on m.live.
    case when m.live then c.logo_url end as logo_url,
    c.service_area,
    (select count(*) from pro_projects pp where pp.contractor_id = c.id) as project_count,
    -- Outbound review-page links (0110): free trust signal, plain links only.
    c.yelp_url,
    c.google_reviews_url,
    -- Newest review with a non-empty comment; both null when there is none.
    lr.comment as latest_review_comment,
    lr.rating  as latest_review_rating,
    -- Up to 3 project photos: "after" shots first, then newest first. Empty
    -- array (never null) when the pro has no photos.
    coalesce((
      select array_agg(ph3.url)
      from (
        select ph.url
        from public.pro_project_photos ph
        join public.pro_projects pj on pj.id = ph.project_id
        where pj.contractor_id = c.id
        order by ph.is_before asc, ph.created_at desc, ph.sort asc
        limit 3
      ) ph3
    ), '{}'::text[]) as photo_urls,
    c.created_at
  from contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Gates only the logo (0109 freed the trust badges),
    -- nothing about rating.
    select exists (
      select 1
      from public.subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%' escape '\'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
  left join lateral (
    -- Most recent review that actually has a comment. reviews.rating is
    -- smallint (0009); cast so it matches the declared int return column.
    select r.comment, r.rating::int as rating
    from public.reviews r
    where r.contractor_id = c.id
      and r.comment is not null
      and btrim(r.comment) <> ''
    order by r.created_at desc
    limit 1
  ) lr on true
  where c.user_id is not null
    -- ORANGE COUNTY LAUNCH GATE: hard filter, same as open_jobs_for_me /
    -- can_preview_job_photo. A homeowner must not reach a pro who has not
    -- confirmed they serve the launch market.
    and c.serves_orange_county = true
    and (p_category is null or p_category = any (c.categories))
  order by
    (c.license_verified_at is not null) desc,
    case when c.review_count > 0 then c.rating end desc nulls last,
    c.review_count desc,
    c.name asc
  limit 200;
$$;

grant execute on function public.browse_pros(text) to anon;
grant execute on function public.browse_pros(text) to authenticated;
