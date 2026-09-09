-- Read-only. Lists every address owned by more than one account, so the
-- address lock (0162) can be applied. Paste into the Supabase SQL editor, run,
-- and send the whole result to Fable (copy as CSV or screenshot).
select
  p.id as property_id,
  p.user_id,
  u.email,
  p.address_line1, p.unit, p.zip,
  p.created_at,
  (select count(*) from public.home_systems hs where hs.property_id = p.id) as systems,
  (select count(*) from public.household_members hm where hm.property_id = p.id) as members,
  lower(regexp_replace(btrim(p.address_line1), '\s+', ' ', 'g')) || '|' || coalesce(p.zip,'') || '|' ||
    lower(regexp_replace(btrim(coalesce(p.unit,'')), '\s+', ' ', 'g')) as dupe_key
from public.properties p
left join auth.users u on u.id = p.user_id
where lower(regexp_replace(btrim(p.address_line1), '\s+', ' ', 'g')) || '|' || coalesce(p.zip,'') || '|' ||
      lower(regexp_replace(btrim(coalesce(p.unit,'')), '\s+', ' ', 'g'))
  in (
    select lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')) || '|' || coalesce(zip,'') || '|' ||
           lower(regexp_replace(btrim(coalesce(unit,'')), '\s+', ' ', 'g'))
    from public.properties
    group by 1 having count(distinct user_id) > 1
  )
order by dupe_key, p.created_at;
