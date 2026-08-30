-- PASTE-ME (2026-08-29): stop shipping full old rows over Realtime.
-- This is migration 0146_realtime_replica_identity.sql, plus the checks to run
-- before and after. Safe to run more than once.
--
-- WHY. 0013_realtime.sql set `replica identity full` on contractor_leads and
-- lead_applications back when the Leads board was new. That tells Postgres to
-- write the ENTIRE pre-change row into the WAL on every update and delete, and
-- Supabase Realtime forwards it to subscribers as payload.old. For
-- contractor_leads that old row is the whole job request: property_id,
-- category, status, payout_amount. Every subscriber realtime admits to the row
-- gets that snapshot on every edit, including columns the page never selected.
--
-- Nothing in the app reads it. Every realtime callback in the codebase ignores
-- its payload and re-queries through PostgREST, which applies RLS and column
-- grants properly; `grep -rn "payload.old\|eventType" src` is empty. So the
-- full row image has no consumer and only downside, and `default` (primary key
-- only) is the right setting.
--
-- WHAT IT COSTS. With `default` a DELETE's old row carries only the primary
-- key, so a subscription with a column filter cannot match a delete and
-- realtime drops it. The only contractor_leads delete in the app is the dedup
-- rollback of a row the same request just inserted, no client waits on it, and
-- nothing deletes lead_applications. INSERT and UPDATE are untouched: their new
-- row is always complete in the WAL whatever the replica identity is, so the
-- live Leads board, the chat and the unread badge behave exactly as today.
--
-- messages and notifications were never set to full. Their statements below are
-- no-ops, included so all four published tables are stated in one place.

-- -----------------------------------------------------------------------------
-- 1. BEFORE. What the live database has right now.
--    relreplident: 'd' = default (primary key), 'f' = full, 'n' = nothing,
--    'i' = index. Expect 'f' on contractor_leads and lead_applications, 'd' on
--    messages and notifications.
-- -----------------------------------------------------------------------------
select c.relname, c.relreplident
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('contractor_leads', 'lead_applications', 'messages', 'notifications')
 order by c.relname;

-- Which tables realtime publishes at all (context for the list above).
select schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
 order by schemaname, tablename;

-- -----------------------------------------------------------------------------
-- 2. APPLY.
-- -----------------------------------------------------------------------------
alter table public.contractor_leads replica identity default;
alter table public.lead_applications replica identity default;
alter table public.messages replica identity default;
alter table public.notifications replica identity default;

-- -----------------------------------------------------------------------------
-- 3. AFTER. Expect relreplident = 'd' on all four rows.
-- -----------------------------------------------------------------------------
select c.relname, c.relreplident
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('contractor_leads', 'lead_applications', 'messages', 'notifications')
 order by c.relname;

-- Nothing should come back: any published public table still on `full` is one
-- this rule has not been applied to yet.
select c.relname, c.relreplident
  from pg_publication_tables p
  join pg_class c on c.relname = p.tablename
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
 where p.pubname = 'supabase_realtime'
   and p.schemaname = 'public'
   and c.relreplident = 'f'
 order by c.relname;
