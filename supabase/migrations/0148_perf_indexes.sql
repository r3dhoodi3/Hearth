-- 0148: nine indexes for the filter-then-sort reads the signed-in pages run
-- on every render. Follows 0084_performance_indexes.sql, which did the same
-- job for the cron sweeps.
--
-- No new tables, columns, functions, policies or grants. Nothing about who can
-- read what changes here. Every statement is `create index if not exists`, so
-- the file is safe to run twice and safe to run on a database that already has
-- some of them.
--
-- WHY THESE NINE. Each table below already has a single-column index on the
-- filter (property_id, contractor_id, related_id). None of them carries the
-- ORDER BY column, so Postgres reads every matching row and then sorts, and
-- the LIMIT on top cannot be pushed into the scan. That is fine at today's row
-- counts and it is exactly the shape that stops being fine as the busiest
-- accounts grow: a pro's lead history and a homeowner's document/issue lists
-- only ever get longer. Making the sort column part of the index turns each of
-- these into an index scan that stops at the limit.
--
-- WHY NOT `create index concurrently`. It cannot run inside a transaction
-- block, and both the Supabase SQL editor (for the PASTE-ME twin of this file)
-- and `supabase db push` wrap a migration in one. These tables are small
-- today, so a plain, briefly-locking CREATE INDEX is measured in milliseconds.
-- If any of them is ever large enough for the write lock to matter, run that
-- one statement on its own, outside a transaction, instead.

-- ---------------------------------------------------------------------------
-- contractor_leads: the pro inbox, the assigned board, and "jobs won"
-- ---------------------------------------------------------------------------
-- src/app/pro/chats/page.tsx      contractor_id = ? order by created_at desc limit 500
-- src/app/pro/leads/page.tsx      contractor_id = ? order by created_at desc limit 500
-- src/app/pro/business/page.tsx   contractor_id = ? and status in (...) order by created_at desc limit 5
-- Existing: contractor_leads_contractor_id_idx (contractor_id) - filter only.
create index if not exists contractor_leads_contractor_created_idx
  on public.contractor_leads (contractor_id, created_at desc);

-- src/app/(app)/contractors/page.tsx  property_id = ? order by created_at desc
-- Existing: contractor_leads_property_id_idx (property_id) - filter only.
create index if not exists contractor_leads_property_created_idx
  on public.contractor_leads (property_id, created_at desc);

-- ---------------------------------------------------------------------------
-- lead_applications: a pro's own applications, newest first
-- ---------------------------------------------------------------------------
-- src/app/pro/chats/page.tsx    contractor_id = ? order by created_at desc limit 200
-- src/lib/responseTime.ts       contractor_id in (...) order by contractor_id, created_at desc
-- Existing: lead_applications_contractor_idx (contractor_id) - filter only.
create index if not exists lead_applications_contractor_created_idx
  on public.lead_applications (contractor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- reviews: the shareable-reviews strip on /pro/business
-- ---------------------------------------------------------------------------
-- contractor_id = ? and rating >= 4 order by created_at desc limit 5.
-- rating stays out of the key: it is a cheap filter on a handful of rows once
-- the scan is already ordered, and leaving it out keeps this index useful for
-- every other "this pro's reviews, newest first" read.
-- Existing: reviews_contractor_idx (contractor_id) - filter only.
create index if not exists reviews_contractor_created_idx
  on public.reviews (contractor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- documents: the homeowner's document list
-- ---------------------------------------------------------------------------
-- src/app/(app)/documents/page.tsx  property_id = ? order by uploaded_at desc
-- Existing: documents_property_id_idx (property_id), plus the partial
-- warranty index from 0084, neither of which orders by uploaded_at.
create index if not exists documents_property_uploaded_idx
  on public.documents (property_id, uploaded_at desc);

-- ---------------------------------------------------------------------------
-- issues: open issues on a home, newest first
-- ---------------------------------------------------------------------------
-- The dashboard, /issues and the Ask Hearth greeting all run
-- property_id = ? and status = 'open' order by created_at desc.
-- Existing: issues_property_id_idx (property_id) - filter only.
create index if not exists issues_property_status_created_idx
  on public.issues (property_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- maintenance_tasks: a home's reminders by due date
-- ---------------------------------------------------------------------------
-- The dashboard reads property_id = ? and status in ('open','done') order by
-- due_date; the greeting reads property_id = ? and status = 'open' order by
-- due_date limit 1. The two partial indexes from 0084 are keyed on due_date
-- alone for the cron sweeps and cannot serve a per-home read.
-- Existing: maintenance_tasks_property_id_idx (property_id) - filter only.
create index if not exists maintenance_tasks_property_due_idx
  on public.maintenance_tasks (property_id, due_date);

-- ---------------------------------------------------------------------------
-- home_systems: the dashboard's systems list, oldest first
-- ---------------------------------------------------------------------------
-- property_id = ? order by created_at asc.
-- Existing: home_systems_property_id_idx (property_id) - filter only.
create index if not exists home_systems_property_created_idx
  on public.home_systems (property_id, created_at);

-- ---------------------------------------------------------------------------
-- photos: job photos on the pro's assigned-lead cards
-- ---------------------------------------------------------------------------
-- src/app/pro/leads/page.tsx  related_type = 'issue' and related_id in (...)
--                             order by uploaded_at asc
-- Existing: photos_related_idx (related_type, related_id) - filter only.
create index if not exists photos_related_uploaded_idx
  on public.photos (related_type, related_id, uploaded_at);
