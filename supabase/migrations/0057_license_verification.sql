-- =============================================================================
-- Hearth - real CSLB license verification (0055)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- license_verified_status (0037) has sat at 'unverified'/'pending' since it
-- shipped: "moving to verified or failed is reserved for a registry
-- integration ... (neither exists yet)". This migration is that integration.
-- src/lib/cslb.ts fetches the contractor's license number against the public
-- CSLB (Contractors State License Board) license-check page and the app
-- writes the result back onto these two new columns; license_verified_status
-- itself already exists and keeps its 0037 values unchanged (unverified,
-- pending, verified, failed).
--
-- license_verified_at: unlike the 0037 comment's original wording ("moved to
-- verified OR failed"), this migration's app code stamps it ONLY when the
-- status moves to 'verified'. That is a deliberate choice made here, not a
-- pre-existing behavior: nothing before this migration ever set 'failed', so
-- there was no real convention to preserve, and keeping this column
-- verified-only lets public_pro_profile() expose it directly as "is this pro
-- verified, and since when" without also leaking a failed check's timestamp.
-- A failed check's timestamp/detail stays in license_verify_detail, which
-- stays private.
--
-- license_verify_detail: the raw-ish CSLB response (business name, status
-- sentence, classifications, expiration) for BOTH outcomes, verified and
-- failed, so a pro can see why a check didn't confirm their license. Private:
-- never selected by public_pro_profile().
--
-- No RLS changes: contractors already has "contractors update own" (0005,
-- user_id = auth.uid()) and "contractors read" (0002, any authenticated
-- user), both row-level with no column restrictions, so they already cover
-- these two new columns.
--
-- Safe to re-run.
-- =============================================================================

alter table public.contractors
  add column if not exists license_verified_at    timestamptz,
  add column if not exists license_verify_detail   jsonb;

comment on column public.contractors.license_verified_at is
  'Set only when license_verified_status moves to verified (never on failed), '
  'so it can double as "is this pro verified" for public_pro_profile(). Null '
  'while unverified/pending/failed.';
comment on column public.contractors.license_verify_detail is
  'Raw-ish detail from the CSLB license-check page for the last check, '
  'whichever outcome: business name, status sentence, classifications, '
  'expiration date. Set on both verified and failed checks so a pro can see '
  'why a failed check did not confirm their license. Never a fetch error: '
  'an ''error'' outcome from src/lib/cslb.ts leaves this column untouched. '
  'Private: never selected by public_pro_profile().';

-- ---- public_pro_profile: 0045 body + 'license_verified_at' -------------------
-- Identical to 0045 (0043 + 'projects') except for the one added key. Rating
-- math, review ordering, member gating, has_license/has_insurance: all
-- byte-for-byte the same. license_verified_at is NOT gated behind member
-- (m.live): license verification is a trust signal, not a paid perk, so it
-- shows for every pro who has actually been verified, free or Pro member.
create or replace function public.public_pro_profile(p_contractor uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id',           c.id,
    'slug',         c.slug,
    'name',         c.name,
    'categories',   coalesce(c.categories, '{}'),
    'created_at',   c.created_at,
    -- Rating exactly as the rest of the app shows it: only real review
    -- averages (review_count > 0), never seeded placeholder values.
    'rating',       case when c.review_count > 0 then c.rating end,
    'review_count', c.review_count,
    'member',       m.live,
    'logo_url',     case when m.live then c.logo_url end,
    'about',        case when m.live then c.about end,
    'has_license',  m.live
                    and c.license_number is not null
                    and btrim(c.license_number) <> '',
    'has_insurance', m.live
                    and c.insurance_carrier is not null
                    and btrim(c.insurance_carrier) <> '',
    -- Real CSLB verification (0055). Free feature, not gated on membership.
    -- Only the timestamp, never the status text or CSLB detail: a 'failed'
    -- check must never be inferable from the public payload.
    'license_verified_at', c.license_verified_at,
    'reviews', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'rating',     r.rating,
                 'comment',    r.comment,
                 'created_at', r.created_at
               ) order by r.created_at desc)
      from (
        select rating, comment, created_at
        from public.reviews
        where contractor_id = c.id
        order by created_at desc
        limit 100
      ) r
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'title',       p.title,
                 'category',    p.category,
                 'description', p.description,
                 'months',      p.months,
                 'photos', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'url',       ph.url,
                              -- Before/After labels are a member perk; the
                              -- photos themselves show for every pro.
                              'is_before', ph.is_before and m.live
                            ) order by ph.sort asc, ph.created_at asc)
                   from public.pro_project_photos ph
                   where ph.project_id = p.id
                 ), '[]'::jsonb)
               ) order by p.sort asc, p.created_at asc)
      from (
        select id, title, category, description, months, sort, created_at
        from public.pro_projects
        where contractor_id = c.id
        order by sort asc, created_at asc
        limit 12
      ) p
    ), '[]'::jsonb)
  )
  from public.contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Perks only; it gates NOTHING about rating or reviews above.
    select exists (
      select 1
      from public.subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
  where c.id = p_contractor;
$$;

grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;
