-- 0158: two more filter-then-sort indexes, same shape and reasoning as
-- 0148_perf_indexes.sql. 0148 covered nine tables filtered by an id and
-- ordered by created_at with no index carrying the sort column; these two
-- were introduced by the pro CRM (0052/0055) and missed that pass.
--
-- No new tables, columns, functions, policies or grants. Every statement is
-- `create index if not exists`, so this file is safe to run twice and safe to
-- run on a database that already has some of it.
--
-- WHY NOT `create index concurrently`: same reasoning as 0148 - it cannot run
-- inside a transaction block, both the Supabase SQL editor and `supabase db
-- push` wrap a migration in one, and both tables are small today.

-- ---------------------------------------------------------------------------
-- pro_clients: the CRM pipeline list, newest first
-- ---------------------------------------------------------------------------
-- src/app/pro/crm/page.tsx  contractor_id = ? order by created_at desc
-- (ran twice per request until this wave's fix removed the second, redundant
-- ilike-filtered query that duplicated this same read - see the page's own
-- comment. The one remaining read still benefits from the sort being in the
-- index.)
-- Existing: pro_clients_contractor_idx (contractor_id) - filter only.
create index if not exists pro_clients_contractor_created_idx
  on public.pro_clients (contractor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- pro_client_notes: a client's note timeline, newest first
-- ---------------------------------------------------------------------------
-- src/app/pro/crm/page.tsx  client_id in (...) order by created_at desc
-- Existing: pro_client_notes_client_idx (client_id) - filter only.
create index if not exists pro_client_notes_client_created_idx
  on public.pro_client_notes (client_id, created_at desc);
