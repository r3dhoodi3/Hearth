-- =============================================================================
-- Hearth - missing indexes for hot query paths (0082)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Purely additive: every statement is `create index if not exists`, so this
-- is idempotent and safe to re-run. Indexes never change query results, only
-- planner cost, so this migration cannot change app behavior.
--
-- NOTE: these are plain `create index` (not `create index concurrently`).
-- CONCURRENTLY cannot run inside a transaction block, and this repo's runner
-- wraps migrations in a transaction, so plain `create index` is used
-- deliberately here to keep the migration simple and transactional. It will
-- briefly hold a write lock on the target table while it builds - fine for
-- these table sizes, but if any of these tables have grown very large by the
-- time this runs, consider running the CONCURRENTLY form by hand instead.
--
-- Each index below cites the exact query it serves and the source file:line
-- verified against the current codebase (2026-07-19).
-- =============================================================================

-- messages: LiveUnreadBadge polls "the other side's most recent messages"
-- with an equality filter on sender_role, ordered by created_at desc.
-- src/components/LiveUnreadBadge.tsx:60-65
--   .from("messages").select("lead_id, sender_role, created_at")
--     .eq("sender_role", OTHER[role]).order("created_at", {ascending:false}).limit(50)
-- The existing messages_lead_idx (0007_messages.sql:15) is (lead_id, created_at)
-- and does not help this query, which has no lead_id filter.
create index if not exists messages_sender_role_created_idx
  on public.messages (sender_role, created_at desc);

-- messages: NewMessageNotifier polls for anything newer than a timestamp,
-- filtered by sender_role <> (own role / 'system') - a range scan on
-- created_at ordered desc, where the sender_role predicates are inequalities
-- and so aren't sargable against a (sender_role, ...) composite index.
-- src/components/NewMessageNotifier.tsx:33-40
--   .from("messages").select("id, lead_id, sender_role, body, created_at")
--     .gt("created_at", sinceRef.current).neq("sender_role", role)
--     .neq("sender_role", "system").order("created_at", {ascending:false}).limit(5)
create index if not exists messages_created_at_idx
  on public.messages (created_at desc);

-- maintenance_tasks: the daily reminder cron's "upcoming" scan - status open,
-- due within the horizon, not yet reminded for this threshold, soonest first.
-- src/app/api/cron/maintenance-reminders/route.ts:99-108
--   .eq("status","open").not("due_date","is",null)
--     .gte("due_date", todayStr).lte("due_date", horizon)
--     .is("reminded_upcoming_at", null).order("due_date",{ascending:true})
-- Only maintenance_tasks_property_id_idx (0001_initial_schema.sql:107) exists
-- today, which does not help a scan with no property_id filter.
create index if not exists maintenance_tasks_open_upcoming_idx
  on public.maintenance_tasks (due_date)
  where status = 'open' and reminded_upcoming_at is null and due_date is not null;

-- maintenance_tasks: the same cron's "overdue" scan - status open, due before
-- today, not yet reminded for this threshold, soonest first.
-- src/app/api/cron/maintenance-reminders/route.ts:109-117
--   .eq("status","open").not("due_date","is",null).lt("due_date", todayStr)
--     .is("reminded_overdue_at", null).order("due_date",{ascending:true})
create index if not exists maintenance_tasks_open_overdue_idx
  on public.maintenance_tasks (due_date)
  where status = 'open' and reminded_overdue_at is null and due_date is not null;

-- documents: the dashboard's "upcoming warranty expirations" card - scoped to
-- one property, non-null warranty_expires, soonest first.
-- src/app/(app)/dashboard/page.tsx:94-99
--   .from("documents").select("id, title, warranty_expires, system_type")
--     .eq("property_id", property.id).not("warranty_expires","is",null)
--     .order("warranty_expires", {ascending:true})
-- Only documents_property_id_idx (0001_initial_schema.sql:213) exists today;
-- this composite lets the planner satisfy the property_id filter AND the
-- warranty_expires order in one index instead of an extra sort step.
create index if not exists documents_property_warranty_idx
  on public.documents (property_id, warranty_expires)
  where warranty_expires is not null;

-- properties: the insurance-renewal cron's global scan for renewals due in
-- the next 45 days - NOT scoped by property_id, so this is a real
-- sequential-scan risk as the properties table grows (same shape of bug as
-- 0081's contractor_leads fix).
-- src/app/api/cron/insurance-renewal/route.ts:111-119
--   .from("properties").select("id, user_id, state, insurance_renewal_date")
--     .not("insurance_renewal_date","is",null)
--     .gte("insurance_renewal_date", todayStr).lte("insurance_renewal_date", horizonStr)
--     .order("insurance_renewal_date", {ascending:true}).limit(500)
-- Only properties_user_id_idx and properties_parcel_id_idx
-- (0001_initial_schema.sql:63-64) exist today; neither helps this column.
create index if not exists properties_insurance_renewal_idx
  on public.properties (insurance_renewal_date)
  where insurance_renewal_date is not null;

-- notifications: the "once-per-key-forever" dup-guard check that most crons
-- run once per candidate before sending a nudge - exact match on
-- (user_id, kind, url), existence-only, called at high frequency inside
-- fan-out loops.
-- src/lib/reviewRequest.ts:45-52
--   .from("notifications").select("id").eq("user_id", ownerId)
--     .eq("kind", "review_request").eq("url", url).limit(1).maybeSingle()
-- src/app/api/cron/insurance-renewal/route.ts:194-201
--   .from("notifications").select("id").eq("user_id", userId)
--     .eq("kind", NUDGE_KIND).eq("url", url).limit(1).maybeSingle()
-- The same .eq("kind", ...) dup-guard shape also appears in
-- src/app/api/cron/renewal-reminders/route.ts, aging-deals/route.ts,
-- pro-winback/route.ts, alerts/route.ts, pro-compliance/route.ts,
-- pro-weekly-digest/route.ts, applicant-nudge/route.ts,
-- filter-reminders/route.ts, and first-apply-guarantee/route.ts.
-- Only notifications_user_read_idx and notifications_user_created_idx
-- (0023_notifications.sql:22-25) exist today; both lead with user_id but
-- neither includes kind or url, so this triple-equality lookup falls back to
-- a user_id index scan plus a row-by-row filter.
create index if not exists notifications_dup_guard_idx
  on public.notifications (user_id, kind, url);
