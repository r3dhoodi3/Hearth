-- =============================================================================
-- Hearth - MEDIUM security remediation (0087)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- Source: docs/SECURITY_AUDIT_2026-07-19.md, MEDIUM section. Five targeted
-- fixes, one per section below. Every function CREATE OR REPLACE in this file
-- was written against that function's LATEST live body, found by grepping
-- every prior migration for "create or replace function public.<name>" /
-- "create function public.<name>" and taking the highest-numbered hit:
--   - enforce_contractor_leads_locked()  latest body: 0084_security_rpc_fixes.sql
--     (NOT 0077 - 0084 added the pg_trigger_depth() CCPA-deletion fix on top
--     of 0077's original body; that fix is preserved byte-for-byte below,
--     with the new status-transition guard layered on as an additional,
--     independent block in the same UPDATE branch).
--   - apply_to_lead(uuid, text)          latest body: 0077_lock_contractor_leads.sql
--     (0083/0084/0085/0086 do not touch it - confirmed by grep).
--   - open_jobs_for_me()                 latest body: 0081_open_jobs_limit.sql
--     (read only, for the serves_orange_county precedent - not modified here).
--
-- market_waitlist (0074), support_messages (0021/0035), reports (0009),
-- messages (0007), lead_reads (0009) have no function bodies to preserve -
-- new constraints/triggers are additive alongside their existing schema.
--
-- Idempotent throughout: CREATE OR REPLACE for functions, DROP TRIGGER IF
-- EXISTS + CREATE for triggers, DROP CONSTRAINT IF EXISTS + ADD for
-- constraints. Safe to re-run.
--
-- This migration was written and reasoned about, but NOT executed against any
-- database (per instructions). Dry-run against a staging copy of the live
-- schema before applying to production.
-- =============================================================================


-- =============================================================================
-- FIX 1 (MED): contractor_leads.status arbitrary transitions
--
-- RLS on contractor_leads is row-level only ("contractor_leads owner all" /
-- "leads contractor update"), so a homeowner or the assigned contractor can
-- already touch any column on a lead they're a party to - including status,
-- which 0077/0084's enforce_contractor_leads_locked() deliberately left
-- unlocked so updateLeadStatusAction (src/app/pro/actions.ts) keeps working.
-- That means a raw PostgREST call can flip status out of the app's intended
-- New -> Accepted -> Closed/Lost sequence: a homeowner can force 'closed' or
-- 'lost' on a job that already has paid applicants (bypassing
-- closeJobAction's "pros have already applied, pick one instead" rule), set
-- 'accepted' with no contractor assigned (contractor_id stays locked to
-- null/old value regardless, but the status field alone corrupts the
-- displayed lifecycle and confuses the ghost-protection / applicant-nudge
-- crons which key off status), or move an already-accepted/closed/lost lead
-- back to 'new'.
--
-- Conservative fix per the audit's own guidance ("if the full state machine
-- is risky, at minimum block the clearly-invalid transitions"): three narrow
-- rules, applied only to non-privileged (hearth.lead_write unset) UPDATEs
-- where status is actually changing, so every RPC-driven transition
-- (choose_applicant, rehire_pro) and every legitimate direct write
-- (updateLeadStatusAction moving accepted -> closed/lost) is untouched:
--
--   (a) Caller must be a party to the lead. RLS already guarantees this for
--       every real client role, but this is cheap defense-in-depth against a
--       future RLS regression - it does NOT run for privileged (RPC) writes,
--       so service-role/admin paths are unaffected.
--   (b) Cannot move directly to 'accepted' outside choose_applicant: blocked
--       whenever the transition is non-privileged, full stop (choose_applicant
--       is the only legitimate path to 'accepted' and it always runs
--       privileged). Closes the "homeowner sets accepted with no contractor"
--       hole named in the task.
--   (c) Cannot move backward to 'new' once the lead is already
--       accepted/closed/lost (the "out-of-sequence flip" the audit flags).
--   (d) A homeowner cannot force 'closed'/'lost' on their own still-open
--       (contractor_id still null) lead once it has at least one live
--       (non-refunded) application - this is exactly closeJobAction's "pick
--       an applicant instead of cancelling" rule, now enforced at the DB
--       layer instead of only in the server action. A homeowner closing a
--       genuinely applicant-free job is untouched.
--
-- Any blocked attempt silently reverts status to its old value (same pattern
-- 0077 already uses for contractor_id/paid/paid_at), rather than raising, so
-- a client that races this trigger sees its other column changes still land
-- - only the forged status is neutralized.
-- =============================================================================
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
    -- statement. Skip ALL anti-forgery stripping (including the new status
    -- guard below) only for that RI-cascade case, so account deletion (CCPA
    -- erase) still works. Direct client writes are always depth = 1.
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
    return new;
  end if;

  return new;
end;
$$;
-- No explicit grants to restate: this is a trigger function (invoked by the
-- system, not called directly), and no prior migration granted EXECUTE on it
-- to any role. The trigger `contractor_leads_locked` (0077) already points at
-- this function name/signature, so CREATE OR REPLACE takes effect
-- immediately without needing to drop/recreate the trigger.
--
-- RESIDUAL (reported, not fixed): this is still not a full state machine.
-- A pro can flip an already-'accepted' lead between 'closed' and 'lost'
-- freely (matches today's shipped behavior - updateLeadStatusAction lets a
-- pro correct a mistaken Won/Lost mark, and the audit did not flag that
-- shape), and a homeowner can still close/lose their OWN applicant-free open
-- job by direct UPDATE instead of going through closeJobAction's DELETE path
-- (harmless: no money or assignment changes hands either way, matches
-- closeJobAction's own end state). A fuller fix would require a real
-- allowed-transitions table keyed by (old_status, new_status, caller_role)
-- and coordination with src/app/pro/actions.ts (updateLeadStatusAction) and
-- src/app/(app)/contractors/actions.ts (closeJobAction) so the DB and the
-- app's own guards can't drift out of sync.


-- =============================================================================
-- FIX 2 (MED): OC launch gate not enforced in apply_to_lead
--
-- open_jobs_for_me() (0074/0081) hard-filters on c.serves_orange_county =
-- true, so the pro board itself already respects the launch gate. But
-- apply_to_lead only checks the applying contractor's `categories` against
-- the job's category - never serves_orange_county or service_state - so a
-- pro who enumerates a lead UUID from the anon-readable lead_previews (or
-- from any other channel: a shared link, browser history, a stale tab) can
-- call apply_to_lead directly and pay to apply to a job outside Orange
-- County even though they never confirmed they serve it. This is the same
-- byte-for-byte apply_to_lead body as 0077 (nothing else in this function
-- changes) with one check added right after the contractor lookup, before
-- any pricing/locking work happens - so a rejected pro never even reaches
-- the FOR UPDATE lock on the lead or the wallet.
--
-- service_state is deliberately NOT re-checked here: open_jobs_for_me()
-- treats it as a soft/permissive locality signal (grandfathered pros with no
-- service_state see everything), so enforcing it hard in apply_to_lead would
-- be stricter than the board that lists the job in the first place and could
-- reject an apply the pro was legitimately shown. serves_orange_county is
-- the one HARD gate open_jobs_for_me() enforces, so it's the one reproduced
-- here.
-- =============================================================================
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[]; v_oc boolean;
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
  v_property uuid; v_owner uuid;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  perform set_config('hearth.lead_write', 'on', true);

  select id, categories, serves_orange_county
    into v_contractor, v_cats, v_oc
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- 0087 fix (MED): reproduce open_jobs_for_me()'s hard Orange County launch
  -- gate here too, so a pro who never confirmed serves_orange_county can't
  -- bypass the board by applying directly against a leaked/guessed lead id.
  if not coalesce(v_oc, false) then
    raise exception 'Confirm you serve Orange County, CA in your profile before applying to jobs';
  end if;

  -- Price the fee from the job's age at apply time (the aging deal). FOR UPDATE
  -- serializes concurrent applies to the same job so the cap below can't be
  -- raced past 3.
  select contractor_id, status, category, property_id,
         public.lead_fee_cents(payout_amount, created_at)
    into v_lead_contractor, v_status, v_category, v_property, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_category is null then raise exception 'Job not found'; end if;
  if v_lead_contractor is not null then return false; end if;  -- already assigned
  if v_status <> 'new' then return false; end if;              -- not open
  if v_cats is not null and not (v_category = any (v_cats)) then
    raise exception 'Job is not in your categories';
  end if;
  if exists (
    select 1 from lead_applications
    where lead_id = p_lead and contractor_id = v_contractor
  ) then
    return true;  -- idempotent: already applied
  end if;

  -- One live lead per relationship (0060's rule): refuse when the pro already
  -- has an active job (not closed/lost) in this category on a property with
  -- the same owner. Closed/lost jobs never block, so rehires and repeat
  -- business stay wide open.
  select pr.user_id into v_owner from properties pr where pr.id = v_property;
  if v_owner is not null and exists (
    select 1
    from contractor_leads active
    join properties ap on ap.id = active.property_id
    where active.contractor_id = v_contractor
      and active.category = v_category
      and active.status not in ('closed', 'lost')
      and ap.user_id = v_owner
  ) then
    raise exception 'Already working with this homeowner';
  end if;

  -- Applicant cap: 3 live (non-refunded) applications fill a job. Keep in sync
  -- with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065 fix: FOR UPDATE so a concurrent charge against this same wallet
  -- (a different lead, or a ghost recharge) can't read a stale balance and
  -- push cash/bonus negative. See migration header for the race.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail.
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: prompt a deposit
  end if;

  select spend_cash_first into v_cash_first from wallet_config where id = 1;
  if v_cash_first then
    v_from_cash := least(v_cash, v_price);
    v_from_bonus := v_price - v_from_cash;
  else
    v_from_bonus := least(v_bonus_avail, v_price);
    v_from_cash := v_price - v_from_bonus;
  end if;

  if v_from_bonus > 0 then
    v_remaining := v_from_bonus;
    for v_grant in
      select * from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now()
      order by expires_at asc, created_at asc
    loop
      exit when v_remaining <= 0;
      if v_grant.remaining_cents >= v_remaining then
        update bonus_grants set remaining_cents = remaining_cents - v_remaining
         where id = v_grant.id;
        v_remaining := 0;
      else
        v_remaining := v_remaining - v_grant.remaining_cents;
        update bonus_grants set remaining_cents = 0 where id = v_grant.id;
      end if;
    end loop;
    if v_remaining > 0 then return false; end if;  -- unreachable safety net
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'apply_fee', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Applied to job');

  return true;
end; $$;
-- Signature is unchanged from 0077's definition, so CREATE OR REPLACE
-- preserves apply_to_lead's existing EXECUTE grants (authenticated) without
-- needing to restate them here.


-- =============================================================================
-- FIX 3 (MED): market_waitlist open anon insert
--
-- 0074's "market_waitlist insert" policy is `with check (true)` for both anon
-- and authenticated - deliberately permissive, because the homeowner landing
-- page form runs before sign-in (anon has no session to scope a check to).
-- That's staying: the task is to keep it anon-insertable while adding a
-- basic guard against garbage/spam rows, not to lock it down.
--
-- Added: a NOT VALID CHECK constraint requiring `email` look like an email
-- (simple, deliberately permissive regex - local-part@domain.tld shape) and
-- be non-empty after trimming. NOT VALID for the same reason as 0077's status
-- check: enforced on every new write immediately, without requiring a scan of
-- whatever rows already exist in the live table to succeed first.
--
-- RESIDUAL (reported, not fixed - this is the real fix): a regex CHECK stops
-- garbage strings but does nothing against a scripted flood of
-- well-formed-looking fake emails (no per-IP/per-session rate limit is
-- possible here - anon has no stable identity to key a rate_limits bucket on,
-- and this table has no auth.uid() to rate-limit by). The actual fix is
-- app-level: move the landing-page submission behind a server action that
-- adds either an IP-based rate_limit_hit() bucket or a CAPTCHA/hCaptcha
-- challenge before the insert, same as any other public unauthenticated form.
-- That is application code, out of scope for this SQL-only migration.
-- =============================================================================
alter table public.market_waitlist
  drop constraint if exists market_waitlist_email_format;
alter table public.market_waitlist
  add constraint market_waitlist_email_format
  check (
    btrim(email) <> ''
    and email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
    and char_length(email) <= 254
  ) not valid;

-- Once confirmed clean (e.g. `select count(*) from public.market_waitlist
-- where btrim(email) = '' or email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
-- or char_length(email) > 254;` returns 0), run this to fully validate:
--   alter table public.market_waitlist validate constraint market_waitlist_email_format;


-- =============================================================================
-- FIX 4 (MED): support_messages / reports rate-limit bypass
--
-- support/help server actions (src/app/(app)/account/help/actions.ts,
-- src/app/pro/help/actions.ts) call rate_limit_hit('support:<user>', 5, 3600)
-- before inserting into support_messages - but that's an application-layer
-- check only; a raw PostgREST insert authenticated as the same user skips it
-- entirely, since support_messages' RLS ("support self insert") only checks
-- user_id = auth.uid(), not any rate. `reports` (src/components/LeadChat.tsx)
-- has no app-level limiter at all today - every "report" / "report message" /
-- "submit report" button calls .insert() directly from the browser.
--
-- rate_limit_hit() itself (0068) is REVOKEd from authenticated/anon and
-- granted only to service_role, specifically so client code can't call it
-- directly - that's correct and unrelated to this fix. A BEFORE INSERT
-- trigger function is a different execution context: it runs with the
-- privileges of its OWNER (this function is created SECURITY DEFINER, owned
-- by whichever role runs this migration, i.e. the same role that owns
-- rate_limit_hit and every other SECURITY DEFINER RPC in this schema), not
-- the inserting client's role - so it can call rate_limit_hit() internally
-- exactly like any other RPC does, with no grant changes needed.
--
-- Deliberately a SEPARATE bucket prefix per table ('support_ins:' /
-- 'reports_ins:'), not the same 'support:<user>' bucket the help actions
-- already use: reusing that bucket would double-count every legitimate send
-- (once from the app's own rate_limit_hit call, again from this trigger),
-- silently cutting the real UX limit from 5/hour to effectively ~2-3/hour.
-- Instead this is an independent, more generous ceiling that exists purely
-- as a hard backstop for the bypass path - normal use through the app's own
-- 5/hour gate never gets close to it.
-- =============================================================================
create or replace function public.enforce_support_messages_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_bucket text := 'support_ins:' || coalesce(auth.uid()::text, 'anon');
  v_window timestamptz :=
    to_timestamp(floor(extract(epoch from now()) / 3600) * 3600);
  v_count int;
begin
  insert into public.rate_limits (bucket, window_start, count)
  values (v_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;
  -- 20/hour: well above the app-level 5/hour UX gate (see header), so this
  -- only ever bites a direct-PostgREST bypass of that gate, never a real user.
  if v_count > 20 then
    raise exception 'Too many support messages sent recently. Please try again later.';
  end if;
  return new;
end; $$;

drop trigger if exists support_messages_rate_limit on public.support_messages;
create trigger support_messages_rate_limit
  before insert on public.support_messages
  for each row execute function public.enforce_support_messages_rate_limit();

create or replace function public.enforce_reports_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_bucket text := 'reports_ins:' || coalesce(auth.uid()::text, 'anon');
  v_window timestamptz :=
    to_timestamp(floor(extract(epoch from now()) / 3600) * 3600);
  v_count int;
begin
  insert into public.rate_limits (bucket, window_start, count)
  values (v_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;
  -- No app-level limiter exists for `reports` today (see header), so this is
  -- the ONLY cap on it, not just a backstop. 20/hour is generous enough for
  -- the legitimate "flag a message" / "flag this conversation" flows (which
  -- fire at most a few times per lead in normal use) while still bounding a
  -- scripted flood.
  if v_count > 20 then
    raise exception 'Too many reports filed recently. Please try again later.';
  end if;
  return new;
end; $$;

drop trigger if exists reports_rate_limit on public.reports;
create trigger reports_rate_limit
  before insert on public.reports
  for each row execute function public.enforce_reports_rate_limit();


-- =============================================================================
-- FIX 5 (MED): messages.sender_role spoofing + lead_reads role forgery
--
-- Both tables let the CLIENT supply a role/sender_role string directly:
--   - "messages insert" (0007) checks only can_access_lead(lead_id) and
--     sender_id = auth.uid() - nothing stops a homeowner from inserting a row
--     with sender_role = 'contractor' (or vice versa), impersonating the
--     other side inside a thread that may later be read as a dispute record.
--   - "lead_reads insert"/"update" (0009) check only can_access_lead(lead_id)
--     - nothing stops either side from writing a read-receipt row under the
--     OTHER side's role, forging "the contractor has seen this" (or hasn't).
--
-- Fix: derive the real role server-side from the caller's actual
-- relationship to the lead (owns_property(property_id) => 'homeowner';
-- otherwise owns the lead's assigned contractor row => 'contractor') and
-- overwrite whatever the client sent, in a BEFORE INSERT (messages) / BEFORE
-- INSERT OR UPDATE (lead_reads, since the app's read-receipt write is an
-- upsert that can hit either path) trigger. A caller who is neither side gets
-- a clean exception instead of a silently-wrong row (RLS would reject them
-- anyway via can_access_lead, but this is a friendlier, earlier failure and
-- defense-in-depth against any future RLS regression).
--
-- CARVE-OUT for messages: sender_role also legitimately takes the literal
-- value 'system' (src/components/LeadChat.tsx's postSystem(), used for the
-- close/reopen thread markers) - inserted by a real party's own session,
-- under their own sender_id, exactly like any other message. That is
-- existing, shipped, non-impersonating behavior (it doesn't claim to BE
-- either homeowner or contractor) and is explicitly out of scope for "role
-- spoofing" - so the trigger only derives/overwrites when the client-supplied
-- sender_role is 'homeowner' or 'contractor'; any other value (system, or
-- anything a future feature introduces) passes through untouched, still
-- gated by the existing can_access_lead + sender_id = auth.uid() RLS check.
-- =============================================================================
create or replace function public.enforce_message_sender_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_property uuid; v_contractor uuid; v_role text;
begin
  if new.sender_role in ('homeowner', 'contractor') then
    select property_id, contractor_id into v_property, v_contractor
      from public.contractor_leads where id = new.lead_id;

    if public.owns_property(v_property) then
      v_role := 'homeowner';
    elsif v_contractor is not null and exists (
      select 1 from public.contractors
      where id = v_contractor and user_id = auth.uid()
    ) then
      v_role := 'contractor';
    else
      raise exception 'Not authorized to post to this lead';
    end if;

    new.sender_role := v_role;
  end if;
  return new;
end; $$;

drop trigger if exists messages_sender_role_guard on public.messages;
create trigger messages_sender_role_guard
  before insert on public.messages
  for each row execute function public.enforce_message_sender_role();

create or replace function public.enforce_lead_reads_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_property uuid; v_contractor uuid; v_role text;
begin
  select property_id, contractor_id into v_property, v_contractor
    from public.contractor_leads where id = new.lead_id;

  if public.owns_property(v_property) then
    v_role := 'homeowner';
  elsif v_contractor is not null and exists (
    select 1 from public.contractors
    where id = v_contractor and user_id = auth.uid()
  ) then
    v_role := 'contractor';
  else
    raise exception 'Not authorized to mark this lead as read';
  end if;

  new.role := v_role;
  return new;
end; $$;

drop trigger if exists lead_reads_role_guard on public.lead_reads;
create trigger lead_reads_role_guard
  before insert or update on public.lead_reads
  for each row execute function public.enforce_lead_reads_role();


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. FIX 1's status guard only engages on non-privileged UPDATEs where status
--    actually changes (new.status IS DISTINCT FROM old.status), inside the
--    existing `not v_privileged and pg_trigger_depth() <= 1` branch - so it
--    can never interfere with choose_applicant/rehire_pro (privileged) or
--    the CCPA-deletion RI cascade (depth > 1, 0084's fix). Dry-run: confirm
--    (a) updateLeadStatusAction still moves an assigned lead
--    accepted -> closed/lost, (b) a raw PostgREST UPDATE setting
--    status = 'accepted' on an unassigned lead is silently reverted,
--    (c) a raw UPDATE setting status = 'new' on an already-accepted lead is
--    reverted, (d) a raw UPDATE setting status = 'closed' on an open lead
--    WITH a live application is reverted while one with zero applications
--    still succeeds.
--
-- 2. FIX 2 changes apply_to_lead's error surface: a pro with
--    serves_orange_county = false now gets a RAISE EXCEPTION (was previously
--    allowed through to the normal category/pricing checks). Confirm the
--    calling code (src/app/(app)/contractors/actions.ts or wherever
--    apply_to_lead is invoked) surfaces RPC exceptions as a user-facing error
--    message rather than a raw 500, consistent with how it already handles
--    'Not a contractor' / 'Job is not in your categories'.
--
-- 3. FIX 3's regex is intentionally permissive (accepts anything shaped like
--    local@domain.tld) - it is a garbage filter, not validation. See the
--    RESIDUAL note in that section for the real fix (app-level throttle or
--    CAPTCHA on the landing-page form), which is out of scope here.
--
-- 4. FIX 4's caps (20/hour) were chosen to sit well above the existing
--    5/hour app-level support gate and the empirically low-frequency report
--    flows, specifically so they never fire for a real user. If either
--    number turns out to be too generous in practice, tighten the `> 20`
--    literal in the corresponding trigger function - no schema change
--    needed.
--
-- 5. FIX 5: the 'system' carve-out means a party CAN still post a message
--    with sender_role = 'system' and arbitrary body text via raw PostgREST
--    today (unchanged by this migration - it was already possible before,
--    via postSystem()'s own client-side call). That is intentionally left
--    alone: it does not impersonate the other side (the audit's actual
--    finding), and locking it down is a product decision about the
--    close/reopen marker feature, not a security fix.
--
-- 6. This migration was written and reasoned about, but NOT executed against
--    any database (per instructions). In particular, `can_access_lead`,
--    `owns_property`, `contractor_lead_base_fee`, `lead_fee_cents`,
--    `get_or_create_wallet`, `rate_limits`/`rate_limit_hit`, and every
--    column referenced above were confirmed by reading
--    0002_rls_policies.sql, 0007_messages.sql, 0009_social.sql,
--    0021_support_messages.sql, 0068_rate_limits.sql,
--    0074_orange_county.sql, 0077_lock_contractor_leads.sql, and
--    0084_security_rpc_fixes.sql directly - but the live DB's actual current
--    state was not and could not be queried. Dry-run against a staging copy
--    of the live schema before applying to production.
-- =============================================================================
