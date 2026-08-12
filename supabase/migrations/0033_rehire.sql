-- =============================================================================
-- Hearth - rehire a pro (My Pros)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- A homeowner who already worked with a pro (an accepted or completed lead)
-- can hire that same pro again for free: no apply fee, no wallet charge. The
-- new job is inserted DIRECTLY assigned to the pro (contractor_id set,
-- status = 'accepted', paid = true) so it shows up exactly like a normal
-- chosen-applicant job: it appears in the pro's "Your jobs" pipeline
-- (contractor_leads where contractor_id = their id, same query pro/page.tsx
-- already runs), and the homeowner/pro can message each other immediately
-- through the existing per-lead thread (messages.lead_id), since that thread
-- only requires contractor_id to be set on the lead, no separate unlock step.
--
-- rehire_pro() is called by the homeowner (client role: authenticated), so
-- unlike apply_deposit/expire_bonus in 0019 it is NOT locked down: it derives
-- everything from auth.uid() and re-checks ownership + prior-hire history
-- itself, the same trusted-entry-point pattern as apply_to_lead and
-- choose_applicant. Default CREATE grants stay in place (no revoke needed).
--
-- Safe to re-run.
-- =============================================================================

create or replace function public.rehire_pro(
  p_property    uuid,
  p_contractor  uuid,
  p_category    text,
  p_description text,
  p_timing      text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_has_history boolean;
  v_name        text;
  v_email       text;
  v_phone       text;
  v_address1    text;
  v_city        text;
  v_state       text;
  v_address     text;
  v_lead_id     uuid;
begin
  if not coalesce(public.owns_property(p_property), false) then
    raise exception 'Not your property';
  end if;

  -- Prior-hire check: the homeowner must have had this pro assigned to a job
  -- (accepted = active, closed = completed) on any property they own. Not
  -- restricted to the current property, since "my pros" spans the household.
  select exists (
    select 1
    from contractor_leads cl
    join properties p on p.id = cl.property_id
    where p.user_id = auth.uid()
      and cl.contractor_id = p_contractor
      and cl.status in ('accepted', 'closed')
  ) into v_has_history;
  if not v_has_history then
    raise exception 'You have not hired this pro before';
  end if;

  -- Contact + address snapshot, same fields a normal posted job carries, so the
  -- new lead renders in the pro's pipeline exactly like any other assigned job.
  select full_name, email, phone into v_name, v_email, v_phone
    from users where id = auth.uid();
  select address_line1, city, state into v_address1, v_city, v_state
    from properties where id = p_property;
  v_address := concat_ws(', ', v_address1, v_city, v_state);

  insert into contractor_leads (
    property_id, issue_id, contractor_id, category, status, payout_amount,
    homeowner_name, homeowner_email, homeowner_phone, property_address,
    issue_description, issue_severity, timing, paid, paid_at
  ) values (
    p_property, null, p_contractor, p_category, 'accepted', 0,
    v_name, v_email, v_phone, v_address,
    p_description, null, p_timing, true, now()
  ) returning id into v_lead_id;

  return v_lead_id;
end; $$;
