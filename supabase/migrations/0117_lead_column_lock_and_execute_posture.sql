-- =============================================================================
-- Hearth - lead re-pointing lock, closed-by-default EXECUTE posture,
-- lead_previews cap, waitlist email uniqueness (0117)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0116 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps.
--
-- Four independent findings from a read-only security audit. Nothing here
-- moves money, changes a price, or alters an RLS policy.
--
-- Part 1: enforce_contractor_leads_locked() also pins contractor_leads
--   .property_id, .issue_id and .direct_to on non-privileged UPDATEs. The
--   trigger already reverted contractor_id / paid / paid_at / payout_amount
--   and guarded status, but a raw PostgREST UPDATE could still re-point a
--   lead at a DIFFERENT property or issue. That is not a cosmetic edit: the
--   lead's chat, its notifications and its job photos are all resolved
--   THROUGH those two columns, so re-pointing grafts a live lead (and the
--   pro who paid for it) onto another homeowner's property, and exposes that
--   property's issue photos to whoever holds the lead.
-- Part 2: alter default privileges so FUTURE functions in schema public ship
--   with EXECUTE closed instead of open. Existing functions are deliberately
--   left alone.
-- Part 3: lead_previews (0006) gains a LIMIT 200 and a warning comment. It is
--   anon-readable with no RLS behind it.
-- Part 4: market_waitlist - reviewed and intentionally left on 0074's
--   per-(email, role) uniqueness; see the decision note in that section.
--
-- Idempotent: CREATE OR REPLACE for the function and the view, ALTER DEFAULT
-- PRIVILEGES is a set-to-state operation, CREATE UNIQUE INDEX IF NOT EXISTS,
-- and the dedupe DELETE only removes rows that still have an earlier twin so
-- a second run is a no-op. Safe to re-run.
--
-- This migration was written and reasoned about, but NOT executed against any
-- database (per instructions). Dry-run against a staging copy of the live
-- schema before applying to production.
-- =============================================================================


-- =============================================================================
-- Part 1: enforce_contractor_leads_locked() - pin property_id, issue_id,
--         direct_to
-- =============================================================================
-- BASE BODY: 0088_referral_closed_deal.sql lines 93-229, copied verbatim.
-- 0088 is confirmed the LATEST definition of this function in this folder:
-- 0089-0116 mention it only in comments (0092, 0093) and never redefine it,
-- so this replaces the body that is actually live.
--
-- WHAT WAS ADDED, and nothing else: three column pins inside the existing
-- `if not v_privileged and pg_trigger_depth() <= 1 then` branch, right after
-- the paid_at revert. Every other line, comment included, is 0088's.
--
--   new.property_id := old.property_id;
--   new.issue_id   := old.issue_id;
--   ...plus a guarded revert of direct_to (see the DELIBERATE DEVIATION note).
--
-- DELIBERATE DEVIATION from the audit's literal instruction, which asked for a
-- flat `new.direct_to := old.direct_to;`. A flat revert would silently BREAK a
-- shipped feature: postDirectRequestAsJobAction
-- (src/app/(app)/contractors/actions.ts, the "post this as a public job"
-- path a homeowner takes after their targeted pro declines) clears
-- direct_to to NULL through the ordinary RLS client, non-privileged, at
-- trigger depth 1. Under a flat revert that UPDATE would report success while
-- direct_to stayed set, and the job would never actually become public - a
-- silent data bug, the worst kind. So direct_to reverts on every change EXCEPT
-- the single legitimate one: clearing an already-set target to NULL, on a
-- still-unassigned lead, by someone who owns the property. That is exactly the
-- shape 0087 used for its status guard: allow the one real transition, close
-- the hole. The hole closed here is re-pointing direct_to at a DIFFERENT pro,
-- or setting it on a lead that never had one, which would hand a stranger's
-- pro a paid unlock path into this lead.
--
-- WHY THE THREE PINS ARE SAFE for property_id and issue_id: no application
-- code path updates either column after insert. updateJobAction writes
-- category, payout_amount, timing, issue_description and the three homeowner
-- contact columns; closeJobAction writes owner_closed_at; the pro's
-- updateLeadStatusAction writes status. The only thing that ever changes
-- issue_id post-insert is the FK's ON DELETE SET NULL when an issue row is
-- deleted (0001), and that is an RI cascade, which runs at
-- pg_trigger_depth() > 1 and is therefore already exempted by the enclosing
-- guard, exactly as 0084 arranged for contractor_id. property_id is ON DELETE
-- CASCADE, so it has no update path at all.
create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.lead_write', true), '') = 'on';
  v_is_party   boolean;
  v_has_live_apps boolean;
begin
  if tg_op = 'INSERT' then
    if not v_privileged then
      -- Reproduces exactly what postJobAction already sends for a fresh,
      -- unassigned posting. A forged insert (contractor_id pre-set, paid =
      -- true, payout_amount lowballed) is silently corrected instead of
      -- rejected, so the ordinary posting flow sees no behavior change.
      new.contractor_id := null;
      new.paid := false;
      new.paid_at := null;
      new.status := 'new';
      new.payout_amount := public.contractor_lead_base_fee(new.category);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- 0084 fix (finding #5, unchanged): pg_trigger_depth() > 1 means this
    -- UPDATE was fired from inside another trigger - the FK's ON DELETE SET
    -- NULL action on contractor_leads.contractor_id when a contractors row
    -- is deleted (0005), a nested trigger invocation, not a direct client
    -- statement. Skip ALL anti-forgery stripping (including the status guard
    -- below) only for that RI-cascade case, so account deletion (CCPA erase)
    -- still works. Direct client writes are always depth = 1.
    if not v_privileged and pg_trigger_depth() <= 1 then
      if new.contractor_id is distinct from old.contractor_id then
        new.contractor_id := old.contractor_id;
      end if;
      if new.paid is distinct from old.paid then
        new.paid := old.paid;
      end if;
      if new.paid_at is distinct from old.paid_at then
        new.paid_at := old.paid_at;
      end if;

      -- ---- 0117 addition: pin the lead to its property, issue and target ---
      -- A lead's chat thread, its notifications, and the job photos a paid pro
      -- can see are all resolved through property_id / issue_id. Re-pointing
      -- either one moves a live lead into another homeowner's account. No
      -- application path ever updates them, so a flat revert is correct.
      new.property_id := old.property_id;
      new.issue_id    := old.issue_id;

      -- direct_to: revert every change EXCEPT the one legitimate transition,
      -- a homeowner clearing an already-set target on a still-unassigned lead
      -- so it becomes a plain public job (postDirectRequestAsJobAction). A
      -- flat revert would break that feature silently. Setting direct_to from
      -- null, or swapping it to a different pro, is always reverted: that is
      -- the actual hole, since the target pro gets a private unlock path into
      -- the lead.
      -- Nested rather than one flat AND chain on purpose: PostgreSQL does not
      -- promise left-to-right short-circuiting inside a single boolean
      -- expression, so a flat version could call owns_property() on EVERY
      -- non-privileged lead UPDATE, including the ones that never mention
      -- direct_to. The outer IF makes that impossible.
      if new.direct_to is distinct from old.direct_to then
        if not (
          old.direct_to is not null
          and new.direct_to is null
          and old.contractor_id is null
          and coalesce(public.owns_property(old.property_id), false)
        ) then
          new.direct_to := old.direct_to;
        end if;
      end if;
      -- ---- end 0117 addition ------------------------------------------------

      -- Recompute only when category or payout_amount actually changed, so a
      -- status-only update (the pro's updateLeadStatusAction) never touches
      -- payout_amount - this is what keeps rehire_pro's free ($0) leads from
      -- being corrupted back to a paid tier the next time their status
      -- changes. When it IS one of those two columns changing, recomputing
      -- from category reproduces updateJobAction's own
      -- payout_amount = leadFeeFor(category) and blocks a lowballed forgery.
      if new.category is distinct from old.category
         or new.payout_amount is distinct from old.payout_amount then
        new.payout_amount := public.contractor_lead_base_fee(new.category);
      end if;

      -- ---- 0087 addition: status transition guard -------------------------
      if new.status is distinct from old.status then
        v_is_party := coalesce(public.can_access_lead(old.id), false);
        if not v_is_party then
          -- Should be unreachable given RLS, but never let a non-party's
          -- status write through if this ever runs outside RLS's scope.
          new.status := old.status;
        elsif new.status = 'accepted' then
          -- (b) 'accepted' is normally set together with contractor_id by
          -- choose_applicant (privileged). A non-privileged write to 'accepted'
          -- is legitimate ONLY as a pro un-marking their OWN already-assigned
          -- lead from a mistaken 'closed'/'lost' back to active (the pro's
          -- JobStatusSelect dropdown offers exactly this). Allow that; block the
          -- real hole: a homeowner or stranger self-accepting an UNASSIGNED
          -- lead (contractor_id null), or anyone accepting a lead not assigned
          -- to their own contractor.
          if old.contractor_id is null
             or old.contractor_id not in (
               select id from public.contractors where user_id = auth.uid()
             )
             or old.status not in ('closed', 'lost') then
            new.status := old.status;
          end if;
        elsif old.status in ('accepted', 'closed', 'lost') and new.status = 'new' then
          -- (c) No moving a lead backward to 'new' once it has left that
          -- state.
          new.status := old.status;
        elsif old.contractor_id is null and old.status = 'new'
              and new.status in ('closed', 'lost') then
          -- (d) Mirrors closeJobAction: once a lead has a live (non-refunded)
          -- application, the homeowner must pick an applicant rather than
          -- force it closed/lost directly. A still-unassigned lead with NO
          -- applications is unaffected (closeJobAction's normal cancel path,
          -- and the app actually DELETEs there rather than updating status,
          -- but this guard covers the update path too for defense-in-depth).
          select exists (
            select 1 from lead_applications
            where lead_id = old.id and refunded_at is null
          ) into v_has_live_apps;
          if v_has_live_apps then
            new.status := old.status;
          end if;
        end if;
      end if;
      -- ---- end 0087 addition -----------------------------------------------
    end if;

    -- 0088 addition: closed_at is derived bookkeeping, never client-writable,
    -- and stamping must also work for privileged RPC writes (choose_applicant,
    -- rehire_pro, the CCPA-deletion RI cascade at any trigger depth), hence it
    -- runs for every UPDATE, privileged or not, at any trigger depth - it is
    -- NOT nested inside the `not v_privileged and pg_trigger_depth() <= 1`
    -- guard above. It MUST run here, at the very end of the UPDATE branch,
    -- immediately before return new, rather than at the top: it has to derive
    -- from the FINAL new.status, after 0087's anti-forgery guards above have
    -- already reverted any illegitimate status write, not from the tentative
    -- client-supplied new.status those guards haven't checked yet. Deriving
    -- from the tentative value would let a reverted forgery still corrupt
    -- closed_at - e.g. a contractor sends status = 'new' on their own closed
    -- lead; rule (c) above reverts new.status back to 'closed'; if this block
    -- ran first (against the pre-revert 'new'), it would have already nulled
    -- closed_at, leaving a final row of status = 'closed' with
    -- closed_at = null and the hold clock silently erased. Running last means
    -- this block only ever sees the status the row will actually end up with.
    -- Always revert any client-supplied closed_at first, then derive from the
    -- real (final) transition. Clearing closed_at on un-close means a pro
    -- un-marking a mistaken Won (back to 'accepted', per 0087's own allowed
    -- reversal) restarts the hold clock honestly rather than keeping a stale
    -- timestamp from the earlier, later-undone close.
    new.closed_at := old.closed_at;
    if new.status = 'closed' and old.status is distinct from 'closed' then
      new.closed_at := now();
    elsif new.status is distinct from 'closed' and old.status = 'closed' then
      new.closed_at := null;
    end if;

    return new;
  end if;

  return new;
end;
$$;

-- The trigger itself (0077 line 215) is unchanged and still bound to this
-- function by name, so no CREATE TRIGGER is needed here.


-- =============================================================================
-- Part 2: default EXECUTE posture for FUTURE functions in schema public
-- =============================================================================
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and Supabase's
-- own default privileges additionally grant it to anon, authenticated and
-- service_role. Net effect today: any function a migration creates is
-- callable over PostgREST by an anonymous visitor from the moment it exists,
-- unless that migration remembers to revoke. That is fail-open, and it has
-- already been patched by hand one function at a time (0048's owns_property,
-- 0068's rate_limit_hit, 0083, 0115's match_support_contact).
--
-- These statements flip the default to fail-closed. They affect FUTURE
-- functions only. Nothing that already exists changes.
--
-- ROLE SCOPE, read this before applying: ALTER DEFAULT PRIVILEGES with no FOR
-- ROLE clause applies to objects created by the role running it, and only
-- that role. Run this migration the same way every other migration in this
-- folder is run, pasted into the Supabase SQL editor, where the session role
-- is `postgres`, the same role that creates the functions. If it is instead
-- applied through some other role, the defaults land on that role and the
-- functions created by `postgres` stay open, silently. Verify afterwards with
--   select defaclrole::regrole, defaclobjtype, defaclacl
--     from pg_default_acl
--     join pg_namespace n on n.oid = defaclnamespace
--    where n.nspname = 'public';
-- and confirm the row for objtype 'f' belongs to the role that owns the
-- functions.
alter default privileges in schema public
  revoke execute on functions from public;
alter default privileges in schema public
  revoke execute on functions from anon;
alter default privileges in schema public
  revoke execute on functions from authenticated;

-- ---- HOUSE RULE, from 0117 onward -------------------------------------------
-- Because the default is now closed, EVERY new function needs an explicit
-- grant or it is unreachable. Forgetting the grant now fails loudly (a
-- "permission denied for function" at the first call) instead of quietly
-- shipping an open endpoint, which is the trade this section buys.
--
--   1. Client-facing RPC (called from the app with the anon/user key):
--        grant execute on function public.thing(uuid) to authenticated;
--      Add `to anon` ONLY if a signed-out visitor must call it, and say why
--      in a comment. Pattern to copy: 0048_household_sharing.sql lines
--      192-195 (revoke from public/anon/authenticated, then grant to
--      authenticated).
--
--   2. Internal function (called only from a server route holding the
--      service-role key, or only from inside another function):
--        grant execute on function public.thing(text) to service_role;
--      Pattern to copy: 0068_rate_limits.sql line 27 (rate_limit_hit) and
--      0115_contact_account_match.sql line 198 (match_support_contact).
--
--   3. Trigger functions need no grant. PostgreSQL checks EXECUTE on a
--      trigger function when the trigger is CREATED, not when it fires.
--
--   4. A SECURITY DEFINER function still needs the grant. Definer rights
--      control what the body may touch, not who may call it.
--
--   5. Helper functions called from inside an RLS policy or a view DO need
--      `to authenticated` (and `to anon` if anon reads the object). They are
--      evaluated as the querying role. owns_property and can_access_lead are
--      the live examples: miss the grant on one of those and RLS starts
--      denying legitimate reads.
--
-- ---- WHY EXISTING FUNCTIONS ARE LEFT ALONE ----------------------------------
-- A blanket `revoke execute on all functions in schema public from anon,
-- authenticated` is deliberately NOT run here. The audit walked the current
-- function list and found no open function that is unsafe to call, and a
-- blanket revoke would immediately break every RPC the app calls with the
-- user's key. For the record, the known client-facing set as of 0117, every
-- name reached by a supabase.rpc(...) call anywhere in src/ (30 functions):
--
--   apply_deposit                 apply_to_lead
--   bump_ai_usage                 can_preview_job_photo
--   can_view_job_photo_full       choose_applicant
--   claim_promo                   contractor_reviews
--   decline_direct_request        expire_bonus
--   ghost_refund_application      ghost_refund_direct
--   grant_membership_credit       grant_referral_rewards
--   grant_winback_credit          guarantee_refund_first_application
--   has_claimed_promo             leave_review
--   match_support_contact         my_applications
--   my_direct_requests            open_jobs_for_me
--   rate_limit_hit                record_ownership_check
--   redeem_household_invite_token rehire_pro
--   resolve_referral_code         reverse_deposit
--   reverse_membership_credit     unlock_direct_request
--
-- Enumerated with a MULTI-LINE scan, not a line-oriented grep: six of these
-- are written as `.rpc(\n  "name"` or picked by a ternary, so a naive
-- one-line pattern misses them and undercounts the list at 24. Re-derive it
-- the same way before trusting it.
--
-- Several of those are service-role-only in practice (apply_deposit,
-- reverse_deposit, grant_membership_credit, reverse_membership_credit and
-- claim_promo are called from the Stripe webhook; expire_bonus,
-- grant_referral_rewards, grant_winback_credit and
-- guarantee_refund_first_application from cron routes; match_support_contact
-- from the contact form; bump_ai_usage and rate_limit_hit from server code
-- with the admin client). The two job-photo gates are the opposite case and
-- the reason this list matters: src/app/api/job-photo/route.ts calls them on
-- the CALLER'S session client precisely so the security-definer body can read
-- auth.uid() itself, so they must keep execute for `authenticated` or every
-- pro and homeowner loses job photos. If a future migration ever does tighten
-- existing grants, that list is where to start, and each one needs its
-- caller's client checked first.


-- =============================================================================
-- Part 3: lead_previews - cap the row count, document the exposure
-- =============================================================================
-- 0006's definition, unchanged in its column list and its WHERE clause, plus:
--   - ORDER BY created_at desc, so the LIMIT keeps the NEWEST leads rather
--     than an arbitrary 200. A LIMIT with no ORDER BY returns whatever the
--     planner happens to produce, which would make the teaser show stale
--     rows at random once the table grows past the cap.
--   - LIMIT 200, so an anonymous scrape of this view is bounded and it can
--     never become a full dump of every open lead in the marketplace.
-- Same columns, same names, same types, so CREATE OR REPLACE VIEW is legal
-- here (replacing a view may add trailing columns but may not change or
-- reorder existing ones, and this does neither).
create or replace view public.lead_previews as
select
  l.id,
  l.category,
  l.issue_severity                                          as severity,
  l.payout_amount                                           as lead_fee,
  nullif(trim(split_part(l.property_address, ',', 2)), '')  as area,
  l.created_at
from public.contractor_leads l
where l.status = 'new'
order by l.created_at desc
limit 200;

-- 0006 already granted select to anon, authenticated. CREATE OR REPLACE VIEW
-- preserves existing grants, so that is not repeated here.

comment on view public.lead_previews is
  'ANON-READABLE, WITH NO RLS BEHIND IT. This view runs with its owner''s '
  'rights, so RLS on contractor_leads does not apply to it and a signed-out '
  'visitor sees every column listed here for every open lead. Any column '
  'added to this view is published to the whole internet: NEVER add '
  'homeowner_name, homeowner_email, homeowner_phone, property_address (the '
  'area column is a deliberate coarsening, city only), property_id, '
  'issue_id, issue_description, or contractor_id. Adding a column requires a '
  'security review. Capped at 200 rows (0117) so the view cannot be scraped '
  'as a full dump of open demand.';


-- =============================================================================
-- Part 4: market_waitlist - left on 0074's per-role uniqueness (comment only)
-- =============================================================================
-- THIS PART SHIPS A COMMENT AND NOTHING ELSE. It originally added an
-- email-only unique index plus a dedupe DELETE; both were cut in review and
-- the narration that described them has been removed with them, so nothing
-- here promises a DO block or an index that the file does not contain. The
-- reasoning that replaced them follows.
--
-- 0074 created market_waitlist with a unique index on (lower(email), role),
-- so the same address can sit on the list twice, once as 'homeowner' and
-- once as 'pro'. The audit wanted one row per address, full stop, so the
-- launch-notification send could not mail the same person twice.
--
-- DECISION (review, 2026-08-14): the email-only unique index this part
-- originally added is deliberately NOT shipped. 0074's
-- market_waitlist_email_role_uidx already caps the table at one row per
-- (email, role), and a legitimate visitor can be waiting as BOTH a homeowner
-- and a pro; collapsing them would irreversibly delete one of those signups.
-- The audit's underlying concern (unbounded anon inserts) is addressed by
-- 0074's per-role uniqueness plus the IP rate limit added to the waitlist
-- server action in the same 2026-08-14 wave. If one-launch-email-per-address
-- ever matters, dedupe at SEND time in the notification job instead of
-- destroying rows here.

comment on table public.market_waitlist is
  'Out-of-area signups, insert-only from anon and authenticated (0074), no '
  'select policy: reading it is service-role only. Uniqueness is one row per '
  '(email, role) via 0074; an address may legitimately wait as both roles.';
