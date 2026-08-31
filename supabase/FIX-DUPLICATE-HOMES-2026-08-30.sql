-- =============================================================================
-- FIX for the MED-22 error you hit running PASTE-ME-ALL-PENDING-2026-08-30-FINAL:
--
--   "2 duplicate (user_id, address, zip, unit) group(s) already exist"
--
-- Two homes exist twice for the same owner at the same address (the exact
-- double-submit bug the new index prevents). Because the paste runs in one
-- transaction, NOTHING was applied; the database is unchanged.
--
-- Run THIS file once. It does two things:
--
--   STEP A (read-only) lists every row in a duplicate group with its child
--          counts, so you can see what each one holds.
--   STEP B deletes, within each duplicate group, every row EXCEPT the oldest,
--          but ONLY when the newer row is empty of real activity: no issues,
--          no jobs, no documents, no photos, no improvements, no household
--          members. Seeded systems and maintenance tasks do not count as
--          activity (every claim seeds those automatically) and cascade away
--          with the row. A newer row that HAS real activity is left alone and
--          named in the output for a manual decision.
--
-- After it reports the deletions, run PASTE-ME-ALL-PENDING-2026-08-30-FINAL.sql
-- again. If STEP B says it kept a row for manual review, paste me the output
-- and I will write the targeted merge.
-- =============================================================================

-- STEP A: what the duplicates are (read-only).
select p.id,
       p.user_id,
       p.address_line1,
       coalesce(p.unit, '') as unit,
       coalesce(p.zip, '')  as zip,
       p.created_at,
       (select count(*) from public.issues            i where i.property_id = p.id) as issues,
       (select count(*) from public.contractor_leads  l where l.property_id = p.id) as jobs,
       (select count(*) from public.documents         d where d.property_id = p.id) as docs,
       (select count(*) from public.photos            f where f.property_id = p.id) as photos,
       (select count(*) from public.improvements      m where m.property_id = p.id) as improvements,
       (select count(*) from public.household_members h where h.property_id = p.id) as members
  from public.properties p
  join (
    select user_id,
           lower(btrim(address_line1)) as addr,
           coalesce(zip, '')  as zip,
           coalesce(unit, '') as unit
      from public.properties
     group by 1, 2, 3, 4
    having count(*) > 1
  ) g on g.user_id = p.user_id
     and lower(btrim(p.address_line1)) = g.addr
     and coalesce(p.zip, '')  = g.zip
     and coalesce(p.unit, '') = g.unit
 order by p.user_id, lower(btrim(p.address_line1)), p.created_at;

-- STEP B: delete the newer, activity-free duplicates. Oldest row in each
-- group is always kept (ties broken by id so the pass is deterministic).
do $$
declare
  r record;
  v_deleted int := 0;
  v_kept    int := 0;
begin
  for r in
    select id from (
      select id,
             row_number() over (
               partition by user_id, lower(btrim(address_line1)),
                            coalesce(zip, ''), coalesce(unit, '')
               order by created_at asc, id asc
             ) as rn,
             count(*) over (
               partition by user_id, lower(btrim(address_line1)),
                            coalesce(zip, ''), coalesce(unit, '')
             ) as cnt
        from public.properties
    ) t
    where t.cnt > 1 and t.rn > 1
  loop
    if exists (select 1 from public.issues            where property_id = r.id)
       or exists (select 1 from public.contractor_leads  where property_id = r.id)
       or exists (select 1 from public.documents         where property_id = r.id)
       or exists (select 1 from public.photos            where property_id = r.id)
       or exists (select 1 from public.improvements      where property_id = r.id)
       or exists (select 1 from public.household_members where property_id = r.id)
    then
      v_kept := v_kept + 1;
      raise notice 'KEPT for manual review (has real activity): %', r.id;
    else
      delete from public.properties where id = r.id;
      v_deleted := v_deleted + 1;
      raise notice 'Deleted empty duplicate: %', r.id;
    end if;
  end loop;
  raise notice 'Done: deleted % empty duplicate(s), kept % for manual review.',
    v_deleted, v_kept;
  if v_kept = 0 then
    raise notice 'All clear. Now run PASTE-ME-ALL-PENDING-2026-08-30-FINAL.sql again.';
  end if;
end
$$;
