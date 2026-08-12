-- =============================================================================
-- Hearth - block self-review through leave_review() (0080)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- HIGH (business-logic audit). leave_review() (0017_review_integrity.sql)
-- already derives the contractor from the lead and verifies the caller owns
-- the job's property (public.owns_property(v_property)), which closes the
-- three holes 0017 was written for (attributing a review to an arbitrary
-- contractor, an assigned pro self-reviewing via a raw insert, and unlimited
-- reviews per job). What it never checked is whether the SAME auth.uid()
-- controls both sides of the job: an account that owns the property AND is
-- linked (contractors.user_id) to the contractor assigned to that job can
-- call leave_review() on their own lead and post themselves a 5-star review.
-- (contractors_unique_user, 0072, only enforces one contractor row per user;
-- nothing stops that user from also owning properties and posting jobs.)
--
-- This is a byte-for-byte reproduction of 0017's leave_review() body, with
-- one added guard: after the contractor is resolved from the lead, reject
-- (RAISE) if that contractor's contractors.user_id = auth.uid(). Signature
-- (p_lead uuid, p_rating smallint, p_comment text) is unchanged, so
-- CREATE OR REPLACE preserves the function's existing default EXECUTE grant
-- to PUBLIC/authenticated (leave_review is not in 0019_security_hardening's
-- lock_down list, so it was never revoked).
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.leave_review(
  p_lead uuid, p_rating smallint, p_comment text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid;
  v_property   uuid;
  v_pro_user   uuid;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;

  select contractor_id, property_id
    into v_contractor, v_property
    from contractor_leads
   where id = p_lead;

  if v_property is null then
    raise exception 'Job not found';
  end if;
  -- Only the homeowner who owns the job's property can review it.
  if not public.owns_property(v_property) then
    raise exception 'You can only review your own job';
  end if;
  -- And only once a pro was actually assigned to that job.
  if v_contractor is null then
    raise exception 'No pro was assigned to this job';
  end if;

  -- Self-review guard (0080): reject when the caller's account is the same
  -- one linked to the assigned contractor, i.e. an account that owns both
  -- the property and the pro company on this job.
  select user_id into v_pro_user from contractors where id = v_contractor;
  if v_pro_user is not null and v_pro_user = auth.uid() then
    raise exception 'You can not review your own company';
  end if;

  insert into public.reviews (lead_id, contractor_id, property_id, rating, comment)
    values (p_lead, v_contractor, v_property, p_rating, nullif(btrim(p_comment), ''))
  on conflict (lead_id) do update
    set rating     = excluded.rating,
        comment    = excluded.comment,
        created_at = now();
end;
$$;
