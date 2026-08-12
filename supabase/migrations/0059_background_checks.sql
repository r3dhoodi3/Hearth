-- =============================================================================
-- Hearth - background checks via Checkr (0057)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Opt-in, Hearth-paid background checks for contractors, via Checkr
-- (src/lib/checkr.ts, dormant without CHECKR_API_KEY). A pro requests a check
-- from /pro/profile; Checkr emails them an invitation, they consent and hand
-- over their info on Checkr's own site, and Checkr reports back a pass/no-pass
-- result via webhook (src/app/api/checkr/webhook). Hearth pays for every
-- check - there is no payment code anywhere in this feature, by design (the
-- owner's call: charging pros for background checks is anti-supply).
--
-- background_check_status: mirrors the one-way honesty rule
-- license_verified_status/_at already uses (0037/0055). background_checked_at
-- is stamped ONLY when status moves to 'clear', and cleared on every other
-- status, including a downgrade from a prior 'clear': an expired or re-run
-- check must never go on showing the badge off a stale timestamp.
--   none     - never started (default)
--   invited  - Checkr invitation sent, waiting on the candidate
--   pending  - candidate completed the invitation, report in progress
--   clear    - report came back clear: badge is live
--   consider - report needs review / did not clear: PRIVATE ONLY, must be
--              indistinguishable from 'none' on the public page
--
-- checkr_candidate_id: Checkr's candidate id (POST /v1/candidates), used to
-- match inbound webhook events back to a contractor. No unique constraint: a
-- pro re-invited after 'consider' or an expired invitation gets a new
-- candidate id and this column is simply overwritten, never queried by its
-- old value again.
--
-- background_check_detail: report id, package slug, completed_at, and the
-- last processed webhook event id (for replay dedupe - see
-- src/app/api/checkr/webhook). NEVER the report contents: Hearth stores a
-- pass/no-pass status, never Checkr's findings. Private: never selected by
-- public_pro_profile().
--
-- No RLS changes: contractors already has "contractors update own" (0005,
-- user_id = auth.uid()) and "contractors read" (0002, any authenticated
-- user), both row-level with no column restrictions, so they already cover
-- these new columns. The webhook itself writes through the admin (service
-- role) client, same as the Stripe webhook, bypassing RLS entirely.
--
-- Safe to re-run.
-- =============================================================================

alter table public.contractors
  add column if not exists background_check_status text not null default 'none'
    check (background_check_status in ('none','invited','pending','clear','consider')),
  add column if not exists background_checked_at    timestamptz,
  add column if not exists checkr_candidate_id       text,
  add column if not exists background_check_detail   jsonb;

comment on column public.contractors.background_check_status is
  'Checkr background check state (0057): none, invited, pending, clear, '
  'consider. Opt-in only, never auto-started. consider must never be '
  'inferable from the public page - only clear does anything publicly.';
comment on column public.contractors.background_checked_at is
  'Set only when background_check_status moves to clear (never on any other '
  'status), so it can double as "is the badge live" for public_pro_profile(). '
  'Cleared on every downgrade, including a re-run after a prior clear.';
comment on column public.contractors.checkr_candidate_id is
  'Checkr candidate id (POST /v1/candidates), used to match inbound webhook '
  'events back to this contractor. Overwritten on a re-invite; no unique '
  'constraint needed since old values are never looked up again.';
comment on column public.contractors.background_check_detail is
  'Report id, package slug, completed_at, and the last processed webhook '
  'event id (for replay dedupe). NEVER the report contents: Hearth stores '
  'status, not findings. Private: never selected by public_pro_profile().';

-- ---- public_pro_profile: 0055 body + 'background_checked_at' ---------------
-- Byte-identical to 0055 except for the one added key. Rating math, review
-- ordering, member gating, has_license/has_insurance, license_verified_at:
-- all unchanged. background_checked_at is NOT gated behind member (m.live):
-- a real background check is a trust signal, not a paid perk, same reasoning
-- as license_verified_at above it.
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
    -- Real Checkr background check (0057). Free feature, not gated on
    -- membership. Only the timestamp, never the status text or detail: a
    -- 'consider' or in-progress check must never be inferable from the
    -- public payload - it is indistinguishable from 'none' out here.
    'background_checked_at', c.background_checked_at,
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
