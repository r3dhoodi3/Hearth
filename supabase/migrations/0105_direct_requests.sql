-- =============================================================================
-- Hearth - direct requests: homeowner asks ONE specific pro (0104)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: today lead flow is one-way. A homeowner posts an open job and every
-- matching pro can pay to apply (0012/0028). This adds the other direction: a
-- homeowner browses the pro directory and reaches out to ONE pro. That pro
-- sees a masked version of the request, pays the same per-category lead fee to
-- unlock it (unlock = accept), and only then gets contact + chat.
--
-- KEY MECHANIC: contractor_leads.contractor_id being set is what opens contact
-- RLS and the chat thread (can_access_lead, 0007). So a direct request stores
-- the target pro in a NEW column direct_to and keeps contractor_id NULL until
-- the pro pays. Nothing about the existing contact/chat gates changes: they
-- still key off contractor_id. Pending direct leads never satisfy any pro RLS
-- policy on contractor_leads (contractor_id is null), so the ONLY way the
-- target pro can see one is the SECURITY DEFINER function my_direct_requests()
-- below, which returns masked, contact-free fields.
--
-- This migration adds:
--   1. contractor_leads.direct_to / direct_declined_at / direct_unlocked_at
--      plus a partial index, and keeps direct leads off the open board.
--   2. open_jobs_for_me(): excludes direct_to IS NOT NULL rows (a direct lead
--      belongs only to its target, never the general board).
--   3. my_direct_requests(): the target pro's masked view of their pending
--      requests, same safe-field posture as open_jobs_for_me plus the fee.
--   4. can_preview_job_photo(): the direct target may preview downscaled photos
--      of their own pending request, on top of every existing allowance.
--   5. unlock_direct_request(): pay-to-accept. Charges the aging lead fee cash
--      first then bonus FIFO, exactly like apply_to_lead (0028), assigns the
--      lead, opens chat. Race-safe (FOR UPDATE + state re-checks).
--   6. decline_direct_request(): the target passes for free (idempotent).
--   7. ghost_refund_direct(): service-role only. If the homeowner never
--      messages within 7 days after unlock, the fee comes back exactly as
--      charged (cash to cash, bonus as a fresh grant), mirroring
--      ghost_refund_application (0028). The pro keeps access.
--   8. browse_pros(): the homeowner-facing directory list, safe public fields
--      only (public_pro_profile posture, 0033), never contact.
--
-- Idempotent: ALTER ... ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- DROP + CREATE / CREATE OR REPLACE for functions. Safe to re-run.
-- =============================================================================

-- ---- 1. direct-request columns ----------------------------------------------
-- direct_to: the single pro this request is aimed at. contractor_id stays NULL
-- until they pay to unlock, so no pro RLS policy on contractor_leads ever
-- matches a pending direct lead. direct_declined_at: the pro passed (free).
-- direct_unlocked_at: the pro paid; also the clock ghost protection runs off.
alter table public.contractor_leads
  add column if not exists direct_to          uuid references public.contractors (id) on delete set null,
  add column if not exists direct_declined_at timestamptz,
  add column if not exists direct_unlocked_at timestamptz;

-- The target pro's pending list and unlock path both look up by direct_to.
create index if not exists contractor_leads_direct_to_idx
  on public.contractor_leads (direct_to)
  where direct_to is not null;

-- Backstop against concurrent duplicate direct requests: at most one PENDING
-- request per (property, target pro). The app checks-then-inserts, but two
-- simultaneous inserts could both pass that check; this partial unique index
-- makes the second one fail at the DB. Scoped to the live pending state only
-- (not yet unlocked, still 'new', not declined), so a homeowner can re-ask the
-- same pro once an earlier request was declined, unlocked, or closed. Every
-- predicate column lives on contractor_leads and the where clause is
-- immutable-safe (plain column comparisons, no now()/volatile calls).
create unique index if not exists contractor_leads_one_pending_direct_idx
  on public.contractor_leads (property_id, direct_to)
  where direct_to is not null
    and contractor_id is null
    and status = 'new'
    and direct_declined_at is null;

-- ---- 2. open_jobs_for_me: exclude direct leads ------------------------------
-- Byte-for-byte 0103's body (same OC gate, city, ownership_verified,
-- plus_poster check, photo_urls, locality/category/application filters, order,
-- limit) with ONE added WHERE clause: `cl.direct_to is null`, so a request
-- aimed at a specific pro never leaks onto the general open board that every
-- matching pro can see. Return type is unchanged, but drop + create keeps the
-- house convention for this function and re-grants EXECUTE to authenticated by
-- default (documented in 0019/0094 as intentional: it derives the caller from
-- auth.uid()).
drop function if exists public.open_jobs_for_me();
create function public.open_jobs_for_me()
returns table (
  id                 uuid,
  category           text,
  timing             text,
  issue_description  text,
  issue_severity     text,
  payout_amount      numeric,
  created_at         timestamptz,
  application_count  bigint,
  has_photos         boolean,
  plus_poster        boolean,
  budget_range       text,
  city               text,
  ownership_verified boolean,
  photo_urls         text[]
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
         exists (
           select 1
           from subscriptions s
           where s.user_id = pr.user_id
             and (s.side = 'homeowner'
                  or s.plan is null
                  or s.plan not like 'pro\_%' escape '\')
             and s.status in ('active', 'trialing')
             and (s.current_period_end is null or s.current_period_end > now())
         ) as plus_poster,
         cl.budget_range,
         pr.city,
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    -- DIRECT REQUESTS (0104): a lead aimed at one specific pro is theirs alone,
    -- surfaced only through my_direct_requests(), never the open board.
    and cl.direct_to is null
    and (c.categories is null or cl.category = any (c.categories))
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    and c.serves_orange_county = true
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;

-- ---- 3. my_direct_requests: the target pro's masked pending list ------------
-- The ONLY read path a pro has to a request aimed at them while it is still
-- pending (contractor_id null, so no RLS policy matches). Returns exactly the
-- same safe, contact-free fields open_jobs_for_me exposes (issue_description is
-- already redacted at write time by the homeowner-side action), PLUS fee_cents
-- so the card can show "Unlock for $X". The fee is priced live from the job's
-- age with the same lead_fee_cents(payout, created_at) helper unlock uses, so
-- the number shown is the number charged. Never selects homeowner_name /
-- _email / _phone / property_address. Only PENDING requests: not yet unlocked
-- (contractor_id null), still open (status 'new', so an owner cancel/close
-- hides it), and not declined by this pro.
create or replace function public.my_direct_requests()
returns table (
  id                uuid,
  category          text,
  timing            text,
  issue_description text,
  issue_severity    text,
  payout_amount     numeric,
  fee_cents         bigint,
  budget_range      text,
  city              text,
  has_photos        boolean,
  photo_urls        text[],
  created_at        timestamptz
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount,
         public.lead_fee_cents(cl.payout_amount, cl.created_at) as fee_cents,
         cl.budget_range,
         pr.city,
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)) as has_photos,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls,
         cl.created_at
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.direct_to = c.id
    and cl.contractor_id is null
    and cl.status = 'new'
    and cl.direct_declined_at is null
  order by cl.created_at desc
  limit 200;
$$;

-- ---- 4. can_preview_job_photo: allow the direct target ----------------------
-- 0103's two-part rule stays: the caller must be entitled to the lead AND the
-- url must really belong to that lead's issue photos (the binding stops a pro
-- pairing an arbitrary object path with a lead they can see). The entitlement
-- half now also passes for the direct target of a still-pending request, so
-- the "Asked for you" card can render a downscaled preview strip before the pro
-- pays. can_view_job_photo_full already covers the assigned contractor after
-- unlock (contractor_id is set), so full-res needs no change here.
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
    );
$$;

grant execute on function public.can_preview_job_photo(uuid, text) to authenticated;

-- ---- 5. unlock_direct_request: pay-to-accept --------------------------------
-- The target pro pays the per-category lead fee to unlock (= accept) a request
-- aimed at them. Money math mirrors apply_to_lead (0028) exactly: price the fee
-- from the job's age (lead_fee_cents), cash first then bonus drawn FIFO across
-- live grants, a single wallet debit, and a ledger row (type 'direct_unlock').
-- On success it assigns the lead (contractor_id = the pro, status 'accepted',
-- paid true), stamps direct_unlocked_at, and records a 'chosen' lead_applications
-- row so the fee has a history entry (and so ghost_refund_direct has a row to
-- mark refunded).
--
-- RACE SAFETY: FOR UPDATE serializes concurrent calls on the same lead, and the
-- contractor_id-is-null / direct_unlocked_at-is-null re-checks after the lock
-- make a double charge impossible; a second caller sees the assigned row and
-- returns true (idempotent) without charging again. The wallet read also takes
-- FOR UPDATE and bonus is capped at the live-grant sum, both mirroring the
-- hardened apply_to_lead (0087), so a stale balance can never overdraw.
--
-- TRIGGER: the assignment UPDATE writes contractor_id/status/paid, all managed
-- by the contractor_leads_locked trigger (0088), so this function raises the
-- hearth.lead_write flag as its first statement (like every money RPC).
--
-- RETURN CONTRACT: false means ONLY "insufficient balance" (Builder 2 turns
-- that into the deposit prompt). Every other non-unlockable state raises, and
-- an already-unlocked-by-me lead returns true. Unlike apply_to_lead there is NO
-- category gate: the homeowner chose this pro on purpose, so a category
-- mismatch must not block them.
create or replace function public.unlock_direct_request(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_direct_to uuid; v_lead_contractor uuid; v_status text;
  v_declined timestamptz; v_unlocked timestamptz; v_price bigint;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  -- Privileged flag: the contractor_leads_locked trigger (0077, latest body
  -- 0088) strips any client write to contractor_id/paid/paid_at/status unless
  -- this session flag is set, exactly as apply_to_lead/choose_applicant do
  -- (0087). Without it, the final assignment UPDATE below would be silently
  -- reverted after the wallet was already debited. Must be the FIRST statement.
  perform set_config('hearth.lead_write', 'on', true);

  select id into v_contractor from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- Lock the lead and price the fee from its age, same as apply_to_lead.
  select direct_to, contractor_id, status, direct_declined_at, direct_unlocked_at,
         public.lead_fee_cents(payout_amount, created_at)
    into v_direct_to, v_lead_contractor, v_status, v_declined, v_unlocked, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_direct_to is null then raise exception 'Not a direct request'; end if;
  if v_direct_to <> v_contractor then raise exception 'Not your request'; end if;

  -- Already unlocked: by me -> idempotent success; otherwise impossible.
  if v_lead_contractor is not null then
    if v_lead_contractor = v_contractor then return true; end if;
    raise exception 'Request already assigned';
  end if;
  if v_declined is not null then raise exception 'Request was declined'; end if;
  if v_status <> 'new' then raise exception 'Request no longer available'; end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065/0087 hardening: FOR UPDATE so a concurrent charge against this same
  -- wallet (a different lead, an apply, a ghost recharge) can't read a stale
  -- balance and push cash/bonus negative.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail after the
  -- lead was already treated as unlockable (0087).
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
    if v_remaining > 0 then return false; end if;  -- safety
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- History row for the paid unlock (also the row ghost_refund_direct marks).
  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, null, 'chosen', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'direct_unlock', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Direct request unlocked');

  -- Assign + open chat: contractor_id set is what unlocks contact and messages.
  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now(), direct_unlocked_at = now()
   where id = p_lead;

  return true;
end; $$;

-- ---- 6. decline_direct_request: the target passes (free) --------------------
-- The pro declines a request aimed at them at no cost. Idempotent: a second
-- call is a no-op success. Only a pending request can be declined (an already
-- unlocked one is assigned and belongs in the normal pipeline). Derives the
-- contractor from auth.uid() and verifies direct_to = them, so a pro can never
-- decline someone else's request.
create or replace function public.decline_direct_request(p_lead uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_direct_to uuid; v_lead_contractor uuid; v_declined timestamptz;
begin
  select id into v_contractor from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  select direct_to, contractor_id, direct_declined_at
    into v_direct_to, v_lead_contractor, v_declined
    from contractor_leads where id = p_lead
    for update;
  if v_direct_to is null then raise exception 'Not a direct request'; end if;
  if v_direct_to <> v_contractor then raise exception 'Not your request'; end if;
  if v_declined is not null then return; end if;         -- idempotent: already declined
  if v_lead_contractor is not null then
    raise exception 'Request already unlocked';           -- can't decline after paying
  end if;

  update contractor_leads set direct_declined_at = now()
   where id = p_lead and direct_declined_at is null;
end; $$;

-- ---- 7. ghost_refund_direct: refund an ignored unlock -----------------------
-- Called only by the daily cron (service role). If a pro paid to unlock a
-- direct request and the homeowner never messaged them within 7 days after the
-- unlock, the fee comes back automatically, restored EXACTLY as it was charged
-- (cash to cash, bonus back as a fresh grant), mirroring
-- ghost_refund_application (0028). Unlike the open-board case the pro KEEPS
-- access (the lead stays assigned, chat stays open): the direct request was a
-- real, accepted job, matching the "accepted = known-low" precedent, so only
-- the money is reversed. Every rule is re-checked here, and the
-- refunded_at-is-null guard on the claiming UPDATE means concurrent or repeat
-- runs can never refund twice.
create or replace function public.ghost_refund_direct(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_app record; v_claimed uuid; v_wallet uuid; v_txn record;
  v_cash_back bigint := 0; v_bonus_back bigint := 0; v_days int;
  v_cash_after bigint; v_bonus_after bigint; v_unlocked timestamptz;
begin
  -- The lead must be an unlocked direct request at least 7 days past unlock.
  select cl.direct_unlocked_at into v_unlocked
    from contractor_leads cl
    where cl.id = p_lead
      and cl.direct_to is not null
      and cl.contractor_id is not null
      and cl.direct_unlocked_at is not null
      and cl.direct_unlocked_at <= now() - interval '7 days';
  if v_unlocked is null then return false; end if;

  -- The paid 'chosen' unlock row for this lead, not yet refunded.
  select la.id, la.lead_id, la.contractor_id, la.fee_cents
    into v_app
    from lead_applications la
    join contractor_leads cl on cl.id = la.lead_id
    where la.lead_id = p_lead
      and la.contractor_id = cl.contractor_id
      and la.refunded_at is null
      and la.status = 'chosen'
      and la.fee_cents > 0;
  if v_app.id is null then return false; end if;

  -- Any homeowner message after the unlock is engagement: no refund. The thread
  -- is per-lead and sender_role marks the side, so this catches the homeowner's
  -- reply regardless of sender_id.
  if exists (
    select 1 from messages m
    where m.lead_id = p_lead
      and m.sender_role = 'homeowner'
      and m.created_at > v_unlocked
  ) then return false; end if;

  -- Claim atomically before touching money.
  update lead_applications set refunded_at = now()
   where id = v_app.id and refunded_at is null and status = 'chosen'
   returning id into v_claimed;
  if v_claimed is null then return false; end if;

  v_wallet := get_or_create_wallet(v_app.contractor_id);

  -- Restore EXACTLY what was charged, from the original debit's split (deltas
  -- stored negative). If that row is somehow missing, refund the whole fee as
  -- cash rather than short the pro.
  select cash_delta_cents, bonus_delta_cents into v_txn
    from wallet_transactions
    where wallet_id = v_wallet and lead_id = p_lead and type = 'direct_unlock'
    order by created_at asc
    limit 1;
  if v_txn.cash_delta_cents is not null then
    v_cash_back  := greatest(0, -v_txn.cash_delta_cents);
    v_bonus_back := greatest(0, -v_txn.bonus_delta_cents);
  else
    v_cash_back := v_app.fee_cents;
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  + v_cash_back,
         bonus_balance_cents = bonus_balance_cents + v_bonus_back,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- Restored bonus behaves like bonus: a fresh grant on the deposit-flow clock.
  if v_bonus_back > 0 then
    select bonus_expiry_days into v_days from wallet_config where id = 1;
    insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
      values (v_wallet, v_bonus_back, v_bonus_back,
              now() + (coalesce(v_days, 60) || ' days')::interval);
  end if;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'ghost_refund', v_cash_back, v_bonus_back,
            v_cash_after, v_bonus_after, p_lead,
            'Ghost protection: homeowner never responded to a direct request');

  return true;
end; $$;

-- Cron-only entry point: no auth.uid() check inside, so client roles must never
-- reach it (same treatment as ghost_refund_application in 0028).
revoke all on function public.ghost_refund_direct(uuid) from public;
revoke all on function public.ghost_refund_direct(uuid) from anon;
revoke all on function public.ghost_refund_direct(uuid) from authenticated;
grant execute on function public.ghost_refund_direct(uuid) to service_role;

-- ---- 8. browse_pros: the homeowner-facing pro directory ---------------------
-- The list behind the homeowner's "browse pros" page. Same safe-public-field
-- posture as public_pro_profile (0033/0055/0057): id, slug, name, categories,
-- real rating (only when review_count > 0, never seeded values), review_count,
-- the license-on-file badge (member-gated, like public_pro_profile), the free
-- CSLB verification timestamp and Checkr background-check timestamp (NOT
-- member-gated, trust signals), the member logo, service_area, and a portfolio
-- project_count. NEVER contact: no email, phone, or address column is selected,
-- so the directory cannot leak how to reach a pro off-platform.
--
-- Only pros with a claimed account (user_id not null) are listed: a direct
-- request has to notify a real user and be unlockable by one, so an unclaimed
-- seed row is not a valid target. Category filter is optional. Order: real
-- license-verified pros first (the strongest trust signal), then by real rating
-- descending (nulls last), then review volume, matching how the app ranks
-- trust elsewhere.
create or replace function public.browse_pros(p_category text default null)
returns table (
  id                   uuid,
  slug                 text,
  name                 text,
  categories           text[],
  rating               numeric,
  review_count         int,
  has_license          boolean,
  license_verified_at  timestamptz,
  background_checked_at timestamptz,
  logo_url             text,
  service_area         text,
  project_count        bigint
) language sql security definer stable set search_path = public as $$
  select
    c.id,
    c.slug,
    c.name,
    coalesce(c.categories, '{}') as categories,
    case when c.review_count > 0 then c.rating end as rating,
    c.review_count,
    (m.live
      and c.license_number is not null
      and btrim(c.license_number) <> '') as has_license,
    c.license_verified_at,
    c.background_checked_at,
    case when m.live then c.logo_url end as logo_url,
    c.service_area,
    (select count(*) from pro_projects pp where pp.contractor_id = c.id) as project_count
  from contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Gates only the logo and license badge, nothing about rating.
    select exists (
      select 1
      from subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%' escape '\'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
  where c.user_id is not null
    -- ORANGE COUNTY LAUNCH GATE: hard filter, same as open_jobs_for_me /
    -- can_preview_job_photo. A homeowner must not reach a pro who has not
    -- confirmed they serve the launch market.
    and c.serves_orange_county = true
    and (p_category is null or p_category = any (c.categories))
  order by
    (c.license_verified_at is not null) desc,
    case when c.review_count > 0 then c.rating end desc nulls last,
    c.review_count desc,
    c.name asc
  limit 200;
$$;

grant execute on function public.browse_pros(text) to anon;
grant execute on function public.browse_pros(text) to authenticated;
