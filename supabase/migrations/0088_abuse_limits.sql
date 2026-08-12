-- =============================================================================
-- Hearth - abuse/cost rate-limit remediation (0086)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Fixes the DB-level half of security audit findings #3, #6, #7, #9
-- (docs/SECURITY_AUDIT_2026-07-19.md). The app-level halves (daily
-- rate_limit_hit caps for job posting and RentCast lookups, a client-side
-- message-length guard, tightened client MIME gates on uploads) ship as code
-- changes alongside this migration; nothing here duplicates those.
--
-- Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- #9. Lead-chat flood: body length CHECK.
--
-- LeadChat.tsx inserts into `messages` directly from the browser (RLS-scoped,
-- not through a server action), with no body length limit anywhere before this
-- migration. A scripted sender could push arbitrarily large rows. The client
-- now caps at 4000 chars before it ever calls insert(), but that's only a
-- courtesy - anyone hitting PostgREST directly with their own session bypasses
-- it entirely. This CHECK is the real backstop.
--
-- Added NOT VALID: this enforces the cap on every future insert/update
-- immediately, without requiring a scan-and-fail over any pre-existing rows
-- that happen to already be longer (there's no evidence any are, but a
-- migration that could fail outright on unknown production data is worse than
-- one that doesn't retroactively re-check it). Run the VALIDATE CONSTRAINT
-- statement below once you've confirmed no existing row violates it, to close
-- that last gap and let the planner treat it as trusted.
-- -----------------------------------------------------------------------------
alter table public.messages
  add constraint messages_body_length
  check (char_length(body) <= 4000) not valid;

-- Once confirmed clean (e.g. `select count(*) from public.messages where
-- char_length(body) > 4000;` returns 0), run this to fully validate:
--   alter table public.messages validate constraint messages_body_length;

-- -----------------------------------------------------------------------------
-- Follow-up NOT covered by this migration (reported, not fixed - see the fix
-- summary): a true per-user SEND-RATE limit on `messages` (e.g. 30/minute)
-- needs the insert moved from the client into a server action, because
-- rate_limit_hit() is service_role-only (0068 revokes it from
-- authenticated/anon) and cannot be called from LeadChat.tsx's browser
-- client. The length CHECK above stops the "huge message" shape of the flood;
-- it does not stop a fast loop of small messages.
-- -----------------------------------------------------------------------------
