-- =============================================================================
-- Hearth - security hardening (0019)
--
-- RUN THIS IN: Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
-- Editing setup.sql alone does NOT change the already-deployed database.
--
-- CRITICAL FIX: apply_deposit() and expire_bonus() are SECURITY DEFINER and take
-- the target/amount as parameters WITHOUT checking auth.uid(). Postgres grants
-- EXECUTE on new functions to PUBLIC by default, so any authenticated user could
-- call rpc('apply_deposit', { p_contractor: <own id>, p_deposit_cents: N }) and
-- credit themselves unlimited wallet cash, then unlock paid leads for free. These
-- are meant to be called only by the service role (Stripe webhook / cron).
--
-- This version is written as a single DO block so it is signature-agnostic and
-- simply SKIPS any function that does not exist. It cannot fail on a missing or
-- differently-typed function. Idempotent and safe to re-run.
-- =============================================================================

do $$
declare
  fn text;
  -- Locked away from all client roles (public / anon / authenticated):
  lock_down text[] := array[
    'apply_deposit',
    'expire_bonus',
    'get_or_create_wallet',
    'recompute_contractor_rating'
  ];
  -- Granted back to service_role only (the webhook / cron call these):
  service_only text[] := array[
    'apply_deposit',
    'expire_bonus',
    'get_or_create_wallet'
  ];
begin
  -- Revoke EXECUTE from every client role, for every overload of each function.
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (lock_down)
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    raise notice 'locked down %', fn;
  end loop;

  -- Grant EXECUTE back to service_role for the ones trusted server code calls.
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (service_only)
  loop
    execute format('grant execute on function %s to service_role', fn);
    raise notice 'granted to service_role %', fn;
  end loop;
end $$;

-- The following definer functions INTENTIONALLY stay executable by authenticated,
-- because each derives the caller from auth.uid() / ownership and is a legitimate
-- client entry point: charge_lead, apply_to_lead, choose_applicant,
-- open_jobs_for_me, my_applications, leave_review, contractor_reviews,
-- bonus_for_deposit, owns_property, can_access_lead (the last two are also used
-- inside RLS policies, which require the querying role to hold EXECUTE).
