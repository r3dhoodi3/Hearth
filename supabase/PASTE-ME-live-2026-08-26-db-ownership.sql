-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0131 (2026-08-26)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0130 before this. After running, live is at 0131.
--
-- WHAT THIS IS: the database half of an IDOR fix. The app-layer guards already
-- shipped in src/app/(app)/contractors/actions.ts,
-- src/app/(app)/issues/actions.ts and src/app/(app)/profile/actions.ts. This
-- file closes the same two holes one layer down, where Supabase publishes the
-- same tables over PostgREST with the anon key and the caller's own session
-- JWT, so an attacker never has to go through a server action at all.
--
--   A) photos.url was unbound. RLS ("photos owner all", 0002) constrains
--      property_id and says nothing about url, and there was no CHECK and no
--      trigger on public.photos. A homeowner could file ANOTHER property's
--      object key under a photos row they own; can_view_job_photo_full (0104)
--      binds a signed url to a lead by matching photos.url, and
--      /api/job-photo then signs it with the SERVICE ROLE, which storage RLS
--      does not apply to. Net effect: full-resolution download of another
--      household's private photos.
--
--   B) contractor_leads.issue_id was unchecked on INSERT. The lead lock
--      trigger pinned it on UPDATE only (0117, latest body 0121), so a raw
--      insert could attach another homeowner's issue to a lead on a property
--      this account owns, which republishes that home's photo keys through
--      open_jobs_for_me.
--
-- IS THIS URGENT? Yes for A. It is a working read of other people's private
-- photos, it needs nothing but an ordinary account and the anon key, and the
-- object keys it needs are already handed to every board-eligible pro in the
-- job board's RSC payload. B is the same class, one step further back.
--
-- NOTHING BREAKS. No policy is added, dropped or altered. No money moves. No
-- price changes. No column is added or dropped. No data is rewritten. Every
-- legitimate write the app makes today already satisfies both new rules: the
-- uploaders have always written propertyId-prefixed keys, and postJobAction
-- now verifies issue_id before it sends it.
--
-- ONE THING TO KNOW BEFORE YOU RUN IT: the new trigger is BEFORE INSERT OR
-- UPDATE, so rows already in public.photos are untouched and keep rendering
-- exactly as they do now. A legacy row whose url does not sit under its own
-- property would fail on its NEXT update - nothing in the app updates photos
-- rows (three inserts, one delete, four selects), so this should be zero rows,
-- and VERIFY QUERY 3 at the bottom counts them so you can see the real number
-- rather than take my word for it. Run that query FIRST if you want the
-- number before anything changes; it is a plain count and changes nothing.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0131_db_layer_ownership.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - push the photo/issue ownership checks down into the database (0131)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0130 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps.
--
-- WHY THIS EXISTS
-- An IDOR sweep added guards to the three server actions that write a
-- client-chosen storage key or row id (validPhotoUrls / issue_id in
-- src/app/(app)/contractors/actions.ts, system_id in
-- src/app/(app)/issues/actions.ts, photo_urls + system id in
-- src/app/(app)/profile/actions.ts). Those guards are correct and they stay.
-- They are also, on their own, not enough: Supabase publishes the same tables
-- over PostgREST with the public anon key and the caller's own session JWT, so
-- an attacker never has to call a server action at all. This is the same
-- threat model 0079 already wrote down for contractor_leads, applied to the
-- two writes that still reach the database with no check on either side.
--
-- THE TWO HOLES
--
--   A) photos.url is unbound. "photos owner all" (0002_rls_policies.sql:67)
--      constrains property_id and says nothing about url, and there is no
--      CHECK and no trigger on public.photos. So an ordinary homeowner can
--      POST /rest/v1/photos with property_id = a home they own, related_id =
--      an issue on that home, and url = ANOTHER property's object key.
--      can_view_job_photo_full (0104) then binds a signed url to a lead purely
--      by matching photos.url, and grants on owns_property(cl.property_id) -
--      both halves satisfied by the attacker's own rows. /api/job-photo signs
--      the result with the ADMIN client, which storage RLS does not apply to,
--      so the attacker downloads another property's private photo at full
--      resolution. The keys are not secret: open_jobs_for_me returns raw
--      photo_urls to every board-eligible pro and src/app/pro/page.tsx puts
--      them in the RSC payload.
--
--   B) contractor_leads.issue_id is unchecked on INSERT.
--      enforce_contractor_leads_locked() pins issue_id on UPDATE (0117's
--      addition, latest body 0121) but its INSERT branch never looks at it,
--      and "contractor_leads owner all" (0002:75) only checks property_id. So
--      a raw insert can attach another homeowner's issue_id to a lead on a
--      property this account owns, which republishes that home's photo keys
--      through open_jobs_for_me and unlocks them through the gate above.
--
-- WHAT THIS MIGRATION DOES
--   Part 1  storage_object_key(): the SQL twin of src/lib/storage.ts's
--           toObjectPath, so the database strips a stored value down to an
--           object key exactly the way the render path does.
--   Part 2  enforce_photo_url_owned(): BEFORE INSERT OR UPDATE trigger on
--           public.photos. The key must sit under new.property_id. Raises, so
--           a forged write fails loudly rather than landing silently.
--   Part 3  enforce_contractor_leads_locked() re-issued: byte-for-byte 0121
--           apart from ONE addition in the INSERT branch, which nulls an
--           issue_id that does not belong to the lead's own property.
--   Part 4  can_preview_job_photo / can_view_job_photo_full re-issued:
--           copy-only apart from ONE added predicate requiring the object
--           key's first segment to equal the lead's property_id. Defence in
--           depth, and it also neutralises any bad photos row written BEFORE
--           Part 2 existed.
--   Part 5  re-assert the 0020 EXECUTE posture on get_or_create_wallet and
--           recompute_contractor_rating.
--
-- WHAT DOES NOT CHANGE: no policy is added, dropped or altered; no money
-- moves; no price changes; no column is added or dropped. Every legitimate
-- write the app makes today already satisfies both new rules, because the
-- uploaders have always written `${propertyId}/...` keys and postJobAction now
-- verifies issue_id before it sends it.
--
-- BLAST RADIUS ON EXISTING ROWS: the Part 2 trigger is BEFORE INSERT OR
-- UPDATE, so rows already in public.photos are untouched and keep rendering.
-- A legacy row whose url does not sit under its property would fail on its
-- next UPDATE - nothing in the app updates photos rows (grep from("photos"):
-- three inserts, one delete, four selects), and the verify queries at the end
-- of the paste file count those rows so the operator can see the real number
-- before and after.
--
-- Idempotent: CREATE OR REPLACE throughout, DROP TRIGGER IF EXISTS before
-- CREATE TRIGGER, and grants are set-to-state. Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PART 1: storage_object_key(value) - the SQL twin of toObjectPath()
-- -----------------------------------------------------------------------------
-- src/lib/storage.ts:21-33 is the one reading of a stored value the whole app
-- agrees on: /api/img signs what it returns, and isOwnedStoragePath
-- (src/lib/ownedStoragePath.ts) checks what it returns. If the database
-- checked a DIFFERENT reading of the same string, an attacker would aim at the
-- gap between the two readings, so this reproduces it step for step:
--
--   1. cut at the first '?' or '#'. A stored value can be a getPublicUrl()
--      result (Supabase appends ?t=... for cache busting) or a signed url
--      carrying ?token=... . Left on, that suffix is attacker-controlled text
--      sitting inside what is supposed to be a plain key.
--   2. if '/home-photos/' appears, everything after the FIRST occurrence is
--      the key.
--   3. otherwise strip a leading 'home-photos/' if present.
--   4. empty reads as null, never as a zero-length key that would prefix-match
--      anything.
--
-- IMMUTABLE: it is pure string arithmetic on its argument, which lets Part 4's
-- gates call it inside a subquery without blocking inlining.
create or replace function public.storage_object_key(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
           case
             when position('/home-photos/' in v.clean) > 0
               then substring(
                      v.clean
                      from position('/home-photos/' in v.clean)
                           + length('/home-photos/')
                    )
             when v.clean like 'home-photos/%'
               then substring(v.clean from length('home-photos/') + 1)
             else v.clean
           end,
           ''
         )
    from (
      select case
               when p_value is null then null
               -- LEAST ignores NULLs, so a value carrying only one of the two
               -- separators still cuts at that one. nullif(...,0) turns "not
               -- found" into NULL rather than into position 0.
               when strpos(p_value, '?') > 0 or strpos(p_value, '#') > 0
                 then left(
                        p_value,
                        least(
                          nullif(strpos(p_value, '?'), 0) - 1,
                          nullif(strpos(p_value, '#'), 0) - 1
                        )
                      )
               else p_value
             end as clean
    ) v;
$$;

revoke all on function public.storage_object_key(text) from public;
revoke all on function public.storage_object_key(text) from anon;
grant execute on function public.storage_object_key(text) to authenticated;
grant execute on function public.storage_object_key(text) to service_role;


-- -----------------------------------------------------------------------------
-- PART 2: bind photos.url to photos.property_id
-- -----------------------------------------------------------------------------
-- The rule is the one src/lib/ownedStoragePath.ts already applies in
-- TypeScript: the key has to sit under the property the row belongs to, and it
-- must not be able to climb back out. Traversal is rejected in raw AND
-- percent-encoded form, because '<mine>/../<theirs>/x.png' starts with the
-- right prefix and resolves somewhere else entirely, and '%2e%2e' is the same
-- attack wearing a hat. Backslashes are not part of a storage key and only
-- ever show up in an attempt to confuse a normalizer.
--
-- RAISE, not silent correction: unlike contractor_leads (where 0079 chose to
-- quietly normalise a forged insert so the ordinary posting flow sees no
-- behaviour change), there is no honest reading of a photos row that points at
-- someone else's object. Nulling the url would leave a broken row; silently
-- rewriting it would be a guess. Every legitimate caller already sends a
-- conforming key, so the only writer that can trip this is one doing something
-- it should not.
--
-- errcode 42501 (insufficient_privilege) so PostgREST answers 403 rather than
-- 500, and so isMissingSchemaError() in src/lib/dbErrors.ts does not mistake
-- it for schema drift and retry.
create or replace function public.enforce_photo_url_owned()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_key    text;
  v_prefix text;
begin
  -- A row with no url stores no reference and can leak nothing.
  if new.url is null then
    return new;
  end if;

  if new.property_id is null then
    raise exception 'photos.url requires a property_id'
      using errcode = '42501';
  end if;

  -- Same ceiling as MAX_STORED_LENGTH in src/lib/ownedStoragePath.ts: an
  -- unbounded string has no business reaching a text column.
  if length(new.url) > 1000 then
    raise exception 'photos.url is not a storage key for this property'
      using errcode = '42501';
  end if;

  v_key    := public.storage_object_key(new.url);
  v_prefix := new.property_id::text || '/';

  if v_key is null
     or strpos(v_key, '..') > 0
     or strpos(v_key, chr(92)) > 0
     or strpos(lower(v_key), '%2e') > 0
     or strpos(lower(v_key), '%2f') > 0
     or strpos(lower(v_key), '%5c') > 0
     -- Strictly longer than the prefix: the bare folder key names no object.
     or length(v_key) <= length(v_prefix)
     or lower(left(v_key, length(v_prefix))) <> lower(v_prefix)
  then
    raise exception 'photos.url is not a storage key for this property'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists photos_url_owned on public.photos;
create trigger photos_url_owned
  before insert or update on public.photos
  for each row execute function public.enforce_photo_url_owned();


-- -----------------------------------------------------------------------------
-- PART 3: enforce_contractor_leads_locked() - check issue_id on INSERT too
-- -----------------------------------------------------------------------------
-- Latest body is 0121_lock_lead_homeowner_fields.sql (after 0079 -> 0086 ->
-- 0089 -> 0090 -> 0119 -> 0121); nothing between 0121 and 0130 redefines it.
-- Reproduced here byte-for-byte apart from the ONE marked addition in the
-- INSERT branch. The trigger itself (0079 line 215, bound by name) is
-- unchanged, so no CREATE TRIGGER is needed here.
--
-- The addition mirrors the UPDATE branch's existing reasoning. 0117 pinned
-- issue_id on UPDATE because "a lead's chat thread, its notifications, and the
-- job photos a paid pro can see are all resolved through property_id /
-- issue_id". That is exactly as true at INSERT time, and an insert has no OLD
-- row to revert to, so the check is against the issues table instead.
--
-- NULLED, not raised, because that matches what the surrounding branch already
-- does with every other forged column ("silently corrected instead of
-- rejected, so the ordinary posting flow sees no behavior change") and matches
-- what postJobAction now does in the app layer: a stale id posts a plain job
-- rather than failing in the owner's face.
--
-- Runs for the PRIVILEGED path too, deliberately, and it is placed before the
-- `if not v_privileged` block for that reason. Every money RPC that inserts a
-- lead (rehire_pro, the direct-request flows) derives issue_id from a lead the
-- caller already owns or from null, so none of them can be affected - but a
-- future privileged writer that got it wrong would be corrected rather than
-- trusted, and a lead pointed at a foreign issue is never something we want in
-- the table regardless of who wrote it.
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
    -- ---- 0131 addition: issue_id must belong to this lead's own property ---
    -- "contractor_leads owner all" (0002) checks property_id and nothing else,
    -- so without this a raw PostgREST insert attaches another homeowner's
    -- issue to a lead on a property this account owns. open_jobs_for_me
    -- aggregates photo_urls by issue_id, and can_view_job_photo_full binds a
    -- signed url to the lead through it, so that forgery republishes the other
    -- home's photo keys and unlocks them full resolution.
    if new.issue_id is not null
       and not exists (
         select 1
           from public.issues i
          where i.id = new.issue_id
            and i.property_id = new.property_id
       )
    then
      new.issue_id := null;
    end if;
    -- ---- end 0131 addition ------------------------------------------------

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

      -- ---- 0119 addition: block the assigned pro from rewriting homeowner
      --      identity and job detail --------------------------------------
      -- The pro's UPDATE policy ("leads contractor update", 0005) re-checks
      -- only contractor_id, so without this the assigned pro could rewrite the
      -- homeowner's name/email/phone (name is shown to the homeowner and on the
      -- review share card - spoofable), the property address, and the job
      -- detail fields on the lead they were assigned. The owner writes these
      -- legitimately through updateJobAction / closeJobAction; the pro must
      -- not. owns_property(old.property_id) is TRUE for the homeowner and any
      -- household member (they reach this row via "contractor_leads owner all",
      -- 0002) and FALSE for the pro (who reaches it via the contractor policy),
      -- so it is the exact owner-vs-pro discriminator. SECURITY INVOKER, and
      -- owns_property is granted to authenticated (0048) and service_role
      -- (0118), so the call resolves for whichever role is writing.
      --
      -- Same nested shape as the direct_to block above, and for the same
      -- reason: the outer IF fires only when one of the protected columns
      -- actually changed, so owns_property() is never evaluated on the pro's
      -- ordinary status-only write (updateLeadStatusAction, the pro's ONLY
      -- legitimate non-privileged write), nor on any update that leaves these
      -- columns alone.
      --
      -- payout_amount is intentionally absent here: category is reverted for
      -- the non-owner, and 0117's recompute block just below derives
      -- payout_amount from the final category, so a pro-forged category and/or
      -- payout_amount still lands on the base fee for the ORIGINAL category
      -- without this block touching the money logic. This runs BEFORE that
      -- recompute so the recompute sees the reverted category.
      if new.homeowner_name    is distinct from old.homeowner_name
         or new.homeowner_email  is distinct from old.homeowner_email
         or new.homeowner_phone  is distinct from old.homeowner_phone
         or new.property_address is distinct from old.property_address
         or new.issue_description is distinct from old.issue_description
         or new.issue_severity   is distinct from old.issue_severity
         or new.budget_range     is distinct from old.budget_range
         or new.timing           is distinct from old.timing
         or new.square_footage   is distinct from old.square_footage
         or new.material_notes   is distinct from old.material_notes
         or new.has_plans_permits is distinct from old.has_plans_permits
         or new.category         is distinct from old.category
         or new.owner_closed_at  is distinct from old.owner_closed_at then
        if not coalesce(public.owns_property(old.property_id), false) then
          new.homeowner_name    := old.homeowner_name;
          new.homeowner_email   := old.homeowner_email;
          new.homeowner_phone   := old.homeowner_phone;
          new.property_address  := old.property_address;
          new.issue_description := old.issue_description;
          new.issue_severity    := old.issue_severity;
          new.budget_range      := old.budget_range;
          new.timing            := old.timing;
          new.square_footage    := old.square_footage;
          new.material_notes    := old.material_notes;
          new.has_plans_permits := old.has_plans_permits;
          new.category          := old.category;
          new.owner_closed_at   := old.owner_closed_at;
        end if;
      end if;
      -- ---- end 0119 addition ------------------------------------------------

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


-- -----------------------------------------------------------------------------
-- PART 4: the two photo gates also require the key to sit under the lead's home
-- -----------------------------------------------------------------------------
-- Defence in depth behind Part 2, and the reason it is worth having anyway:
-- Part 2's trigger only sees writes made AFTER it is applied. Any photos row
-- already carrying a foreign key stays in the table, and these gates are what
-- decides whether /api/job-photo hands it to the admin client for signing. The
-- added predicate makes such a row unusable even if it exists.
--
-- can_preview_job_photo: latest body is 0105_direct_requests.sql:205 (0104's
-- version plus the direct-request branch). can_view_job_photo_full: latest
-- body is 0104_job_photos_for_pros.sql:184; 0105 does NOT redefine it.
-- Both reproduced copy-only apart from the ONE marked line in the binding
-- subquery. Both keep `security definer`, `stable`, `set search_path`, and
-- their grants are re-stated below because CREATE OR REPLACE preserves them
-- but re-stating costs nothing and makes the posture readable in one place.

create or replace function public.can_preview_job_photo(
  p_lead_id uuid,
  p_photo_url text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    (
      -- (a) board-eligible pro for this open lead (unchanged from 0103).
      exists (
        select 1
        from contractor_leads cl
        join contractors c on c.user_id = auth.uid()
        left join properties pr on pr.id = cl.property_id
        where cl.id = p_lead_id
          and cl.contractor_id is null
          and cl.status = 'new'
          and cl.direct_to is null
          and (c.categories is null or cl.category = any (c.categories))
          and (c.service_state is null
               or pr.state is null
               or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
          and c.serves_orange_county = true
      )
      -- (b) NEW: the direct target of a pending request aimed at them.
      or exists (
        select 1
        from contractor_leads cl
        join contractors c on c.user_id = auth.uid()
        where cl.id = p_lead_id
          and cl.direct_to = c.id
          and cl.contractor_id is null
          and cl.status = 'new'
          and cl.direct_declined_at is null
      )
    )
    and exists (
      select 1
      from photos p
      join contractor_leads cl on cl.issue_id = p.related_id
      where cl.id = p_lead_id
        and p.related_type = 'issue'
        and p.url = p_photo_url
        -- 0131: the object key has to sit under the lead's OWN property, so a
        -- photos row that points somewhere else cannot be laundered into a
        -- signing request through a lead the caller is allowed to see.
        and lower(left(
              public.storage_object_key(p.url),
              length(cl.property_id::text) + 1
            )) = lower(cl.property_id::text || '/')
    );
$$;

grant execute on function public.can_preview_job_photo(uuid, text) to authenticated;

create or replace function public.can_view_job_photo_full(
  p_lead_id uuid,
  p_photo_url text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from photos p
      join contractor_leads cl on cl.issue_id = p.related_id
      where cl.id = p_lead_id
        and p.related_type = 'issue'
        and p.url = p_photo_url
        -- 0131: same binding as can_preview_job_photo above. This is the gate
        -- that unlocks FULL resolution through the admin client, so it is the
        -- one the photos.url forgery was actually aimed at.
        and lower(left(
              public.storage_object_key(p.url),
              length(cl.property_id::text) + 1
            )) = lower(cl.property_id::text || '/')
    )
    and exists (
      select 1
      from contractor_leads cl
      where cl.id = p_lead_id
        and (
          public.owns_property(cl.property_id)
          or cl.contractor_id in (
            select id from contractors where user_id = auth.uid()
          )
          or exists (
            select 1
            from lead_applications la
            join contractors c on c.id = la.contractor_id
            where la.lead_id = cl.id
              and c.user_id = auth.uid()
          )
        )
    );
$$;

grant execute on function public.can_view_job_photo_full(uuid, text) to authenticated;


-- -----------------------------------------------------------------------------
-- PART 5: re-assert the EXECUTE posture on two SECURITY DEFINER helpers
-- -----------------------------------------------------------------------------
-- get_or_create_wallet(uuid) (0010:107) and recompute_contractor_rating(uuid)
-- (0016:16) are SECURITY DEFINER and take their target as a parameter without
-- consulting auth.uid(). Postgres grants EXECUTE on a new function to PUBLIC
-- by default, which is what made that dangerous.
--
-- HONEST NOTE: 0020_security_hardening.sql ALREADY revokes both from public,
-- anon and authenticated (its `lock_down` array names them explicitly) and
-- grants get_or_create_wallet back to service_role. Neither function has been
-- re-created since, and CREATE OR REPLACE does not reset grants, so on a
-- database that ran 0020 this part is a no-op. It is re-stated here because
-- 0020 is a DO block that SKIPS silently when a function is missing, this repo
-- has no schema_migrations bookkeeping, and the live database is believed to
-- have lagged the repo at various points - so "0020 ran" is an assumption, not
-- a fact, and re-asserting it costs one statement each.
--
-- recompute_contractor_rating deliberately gets NO grant back. Its only caller
-- is the reviews_sync_rating trigger function (0016:37), which is itself
-- SECURITY DEFINER and therefore runs as the owner, so revoking authenticated
-- does NOT break a homeowner writing a review.
revoke all on function public.get_or_create_wallet(uuid) from public;
revoke all on function public.get_or_create_wallet(uuid) from anon;
revoke all on function public.get_or_create_wallet(uuid) from authenticated;
grant execute on function public.get_or_create_wallet(uuid) to service_role;

revoke all on function public.recompute_contractor_rating(uuid) from public;
revoke all on function public.recompute_contractor_rating(uuid) from anon;
revoke all on function public.recompute_contractor_rating(uuid) from authenticated;

-- <<<<<<<<<< END 0131_db_layer_ownership.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY QUERIES - run these AFTER the bundle above. Uncomment and run each.
-- Every one is read-only.
-- ============================================================================

-- 1. The trigger exists on public.photos and fires before insert AND update.
--    Expected: 1 row, photos_url_owned, definition showing BEFORE INSERT OR
--    UPDATE ... FOR EACH ROW EXECUTE FUNCTION public.enforce_photo_url_owned().
--   select t.tgname,
--          pg_get_triggerdef(t.oid) as definition
--     from pg_trigger t
--    where t.tgrelid = 'public.photos'::regclass
--      and not t.tgisinternal;

-- 2. The key normalizer agrees with src/lib/storage.ts's toObjectPath.
--    Expected, in order: abc/x.png, abc/x.png, abc/x.png, abc/x.png, NULL, NULL.
--   select public.storage_object_key('abc/x.png')                             as bare,
--          public.storage_object_key('home-photos/abc/x.png')                 as bucket_prefixed,
--          public.storage_object_key('https://p.supabase.co/storage/v1/object/public/home-photos/abc/x.png') as full_url,
--          public.storage_object_key('abc/x.png?t=123')                       as query_stripped,
--          public.storage_object_key('')                                      as empty_is_null,
--          public.storage_object_key(null)                                    as null_is_null;

-- 3. How many EXISTING photos rows would fail the new rule. These are not
--    blocked (the trigger only sees new writes) but they are the rows that
--    would fail if something ever updated them, and any row here whose key
--    sits under a DIFFERENT property's folder is worth looking at by hand.
--    Expected: 0. If it is not 0, paste the result back before doing anything.
--   select count(*) as offending_rows
--     from public.photos p
--    where p.url is not null
--      and (
--        public.storage_object_key(p.url) is null
--        or lower(left(public.storage_object_key(p.url), length(p.property_id::text) + 1))
--           <> lower(p.property_id::text || '/')
--      );

-- 3b. If query 3 returned more than 0, this shows which ones, capped at 50.
--     related_type/related_id tell you whether they are issue photos (the ones
--     the job board and /api/job-photo can reach) or system photos.
--   select p.id, p.property_id, p.related_type, p.related_id,
--          public.storage_object_key(p.url) as object_key
--     from public.photos p
--    where p.url is not null
--      and (
--        public.storage_object_key(p.url) is null
--        or lower(left(public.storage_object_key(p.url), length(p.property_id::text) + 1))
--           <> lower(p.property_id::text || '/')
--      )
--    limit 50;

-- 4. Smoke test the trigger without leaving anything behind. The insert must
--    FAIL with "photos.url is not a storage key for this property"; the
--    ROLLBACK undoes everything either way. Replace the two uuids with a real
--    property id and any other uuid.
--   begin;
--     insert into public.photos (property_id, related_type, related_id, url)
--     values ('<a real property id>', 'issue', gen_random_uuid(),
--             '<some other property id>/stolen.jpg');
--   rollback;

-- 5. The lead lock trigger now checks issue_id on INSERT. Expected: 1 row,
--    has_insert_check = true.
--   select prosrc like '%0131 addition: issue_id must belong%' as has_insert_check
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'enforce_contractor_leads_locked';

-- 6. Both photo gates carry the property-prefix binding. Expected: 2 rows,
--    both binds_key_to_property = true.
--   select proname,
--          prosrc like '%storage_object_key%' as binds_key_to_property
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('can_preview_job_photo', 'can_view_job_photo_full')
--    order by proname;

-- 7. EXECUTE posture on the two SECURITY DEFINER helpers. Expected:
--    get_or_create_wallet -> service_role only; recompute_contractor_rating ->
--    no client role at all (its only caller, the reviews_sync_rating trigger
--    function, is itself SECURITY DEFINER, so an empty acl here is correct and
--    homeowners can still write reviews).
--   select p.proname, p.prosecdef,
--          coalesce(array(select unnest(p.proacl)::text), array[]::text[]) as acl
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('get_or_create_wallet', 'recompute_contractor_rating')
--    order by p.proname;

-- 8. Nothing regressed on the job board. Run this as a SIGNED-IN PRO if you
--    can; as service_role auth.uid() is null and 0 rows is the correct answer,
--    which tells you nothing. Optional.
--   select count(*) from public.open_jobs_for_me();
