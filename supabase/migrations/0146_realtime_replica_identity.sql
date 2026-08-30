-- =============================================================================
-- Hearth - narrow the realtime row images back to the primary key.
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY
-- 0013_realtime.sql:33-34 set `replica identity full` on contractor_leads and
-- lead_applications. That makes Postgres put the ENTIRE pre-change row into
-- the WAL for every update and delete, and Supabase Realtime hands that old
-- row to subscribers as payload.old. For contractor_leads the old row is the
-- job request itself: property_id, category, status, payout_amount. Anyone
-- realtime admits to a row therefore receives a full snapshot of it on every
-- edit, including columns the UI never asked for and would not have selected.
-- Nothing in the app reads that snapshot: `grep -rn "payload.old\|eventType"
-- src` over the whole tree comes back empty, because every subscription
-- callback in the codebase ignores its payload and re-queries through
-- PostgREST (which applies RLS and column grants properly). So the full row
-- image is pure exposure with no consumer, and `default` (primary key only)
-- is the correct setting.
--
-- WHAT THIS COSTS
-- With `default`, a DELETE's old row carries only the primary key, so a
-- subscription with a column filter (LeadsRealtime's
-- `contractor_id=eq.<id>`) can no longer match a delete, and realtime drops
-- it. That is acceptable here: the only contractor_leads delete in the app is
-- the dedup rollback of a row the same request just inserted
-- (src/app/(app)/contractors/actions.ts:712), no client is waiting on it, and
-- nothing deletes lead_applications at all. INSERT and UPDATE are unaffected:
-- their new row is always complete in the WAL regardless of replica identity,
-- so both the filters and the live UI keep working.
--
-- messages and notifications were never set to full (0013 and 0106 only add
-- them to the publication), so the two statements below are no-ops that pin
-- the intent: same rule, same reason, and a future migration that flips one
-- of them to full has to argue with this file.
-- =============================================================================

-- Both tables have a primary key (contractor_leads.id, lead_applications.id),
-- which is what `default` uses, so replication stays valid.
alter table public.contractor_leads replica identity default;
alter table public.lead_applications replica identity default;

-- Already default; stated so the rule covers every published table.
alter table public.messages replica identity default;
alter table public.notifications replica identity default;

-- Verify (expect relreplident = 'd' on all four):
--   select c.relname, c.relreplident
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public'
--      and c.relname in ('contractor_leads','lead_applications','messages','notifications')
--    order by c.relname;
