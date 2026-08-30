-- PASTE ME into the Supabase SQL editor (Dashboard > SQL Editor > New query),
-- then press Run. This is the live twin of
-- supabase/migrations/0148_perf_indexes.sql.
--
-- Safe to run more than once: every statement is `create index if not exists`.
-- Nothing here adds or removes a table, column, function, policy or grant, so
-- nobody's access changes. It only gives Postgres a cheaper way to answer
-- lookups it already answers on every signed-in page load.
--
-- Order does not matter and there is nothing to run before it. Takes a second
-- or two on today's data.

create index if not exists contractor_leads_contractor_created_idx
  on public.contractor_leads (contractor_id, created_at desc);

create index if not exists contractor_leads_property_created_idx
  on public.contractor_leads (property_id, created_at desc);

create index if not exists lead_applications_contractor_created_idx
  on public.lead_applications (contractor_id, created_at desc);

create index if not exists reviews_contractor_created_idx
  on public.reviews (contractor_id, created_at desc);

create index if not exists documents_property_uploaded_idx
  on public.documents (property_id, uploaded_at desc);

create index if not exists issues_property_status_created_idx
  on public.issues (property_id, status, created_at desc);

create index if not exists maintenance_tasks_property_due_idx
  on public.maintenance_tasks (property_id, due_date);

create index if not exists home_systems_property_created_idx
  on public.home_systems (property_id, created_at);

create index if not exists photos_related_uploaded_idx
  on public.photos (related_type, related_id, uploaded_at);

-- ---------------------------------------------------------------------------
-- VERIFY. Run this after the statements above. It should return 9 rows, one
-- per index name below. Fewer rows means one did not get created: re-run the
-- block above and read the error message.
-- ---------------------------------------------------------------------------
select indexname, tablename
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'contractor_leads_contractor_created_idx',
    'contractor_leads_property_created_idx',
    'lead_applications_contractor_created_idx',
    'reviews_contractor_created_idx',
    'documents_property_uploaded_idx',
    'issues_property_status_created_idx',
    'maintenance_tasks_property_due_idx',
    'home_systems_property_created_idx',
    'photos_related_uploaded_idx'
  )
order by tablename, indexname;

-- ---------------------------------------------------------------------------
-- OPTIONAL second check: prove Postgres is actually using one of them. Swap
-- the id for a real contractor id. The plan should name
-- contractor_leads_contractor_created_idx and should NOT contain a "Sort"
-- node above the scan.
-- ---------------------------------------------------------------------------
-- explain analyze
-- select id, homeowner_name, category, property_address, created_at
-- from public.contractor_leads
-- where contractor_id = '00000000-0000-0000-0000-000000000000'
-- order by created_at desc
-- limit 500;
