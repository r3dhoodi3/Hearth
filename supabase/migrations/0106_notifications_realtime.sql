-- =============================================================================
-- Hearth - add public.notifications to Supabase Realtime (0105)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- Realtime only pushes changes for tables in the `supabase_realtime`
-- publication. 0013 added contractor_leads / lead_applications / messages, but
-- NOT notifications. The pro Leads board subscribes to its own notification
-- inserts so a pending DIRECT request (a contractor_leads row that is invisible
-- to the pro under RLS while contractor_id is null) still refreshes the board
-- instantly, via the RLS-visible notifications row the request also writes. That
-- push only fires if notifications is published, so add it idempotently here.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end $$;
