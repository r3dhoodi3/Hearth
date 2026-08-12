-- Contractors RLS hardening (0067). RUN AGAINST LIVE DB.
create or replace function public.contractor_related_to_me(p_contractor uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.contractor_leads cl
    where cl.contractor_id = p_contractor and public.owns_property(cl.property_id)
  ) or exists (
    select 1 from public.lead_applications la
    join public.contractor_leads cl on cl.id = la.lead_id
    where la.contractor_id = p_contractor and public.owns_property(cl.property_id)
  );
$$;

drop policy if exists "contractors read" on public.contractors;
create policy "contractors read" on public.contractors
  for select to authenticated
  using ( user_id = auth.uid() or public.contractor_related_to_me(id) );

create or replace function public.resolve_referral_code(p_code text)
returns uuid language plpgsql security definer stable set search_path = public as $$
declare v_code text := lower(btrim(p_code)); v_id uuid; v_cnt int;
begin
  if v_code = '' or length(v_code) > 100 then return null; end if;
  begin
    select id into v_id from public.contractors where id = v_code::uuid;
    if v_id is not null then return v_id; end if;
  exception when invalid_text_representation then null; end;
  select id into v_id from public.contractors where lower(slug) = v_code limit 1;
  if v_id is not null then return v_id; end if;
  if v_code ~ '^[0-9a-f]{8}$' then
    select count(*) into v_cnt from public.contractors where left(id::text,8) = v_code;
    if v_cnt = 1 then
      select id into v_id from public.contractors where left(id::text,8) = v_code;
      return v_id;
    end if;
  end if;
  return null;
end; $$;
grant execute on function public.resolve_referral_code(text) to authenticated;

revoke select on public.contractors from authenticated;
revoke select on public.contractors from anon;
grant select
  (id, user_id, name, categories, service_area, rating, review_count,
   license_number, contact_phone, contact_email, slug, logo_url, about, created_at)
  on public.contractors to authenticated;
