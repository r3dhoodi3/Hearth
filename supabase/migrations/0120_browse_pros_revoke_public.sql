-- =============================================================================
-- Hearth - close anon EXECUTE on browse_pros for real (0120)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: 0118 Part 2 tried to stop anonymous callers from bulk-reading the pro
-- directory via browse_pros(text), but it only did
--   revoke execute on function public.browse_pros(text) from anon;
-- PostgreSQL grants EXECUTE on every function to PUBLIC by default, and anon
-- inherits that PUBLIC grant, so revoking from anon alone left the function
-- wide open. Verified live: after 0118 an anonymous request to
-- /rest/v1/rpc/browse_pros still returned the full directory. (0118's
-- resolve_referral_code revoke worked precisely because it revoked from PUBLIC
-- too; browse_pros was the one that missed it.)
--
-- This is the same low-severity item the audit flagged: browse_pros exposes
-- only what the public /p/<id> pages already show, but as a one-request bulk
-- scrape rather than a per-profile view, and it was meant to be authenticated
-- only. The signed-in browse page keeps working: the `authenticated` grant
-- (0111 line 154) is untouched.
--
-- Idempotent: REVOKE is naturally re-runnable. Safe to run even if 0118/0119
-- have not been applied, since it only tightens grants that exist from 0111.
-- =============================================================================

revoke execute on function public.browse_pros(text) from public;
revoke execute on function public.browse_pros(text) from anon;

comment on function public.browse_pros(text) is
  'Signed-in pro directory browse. EXECUTE is authenticated-only: the default '
  'PUBLIC grant and the old anon grant are both revoked (0120), because the '
  'anonymous path was a bulk directory scrape. The public per-profile view is '
  'served by public_pro_profile / public_pro_id_for_slug instead.';
