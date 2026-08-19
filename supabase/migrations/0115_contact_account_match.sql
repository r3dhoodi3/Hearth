-- =============================================================================
-- Hearth - silent account match for public contact messages (0115)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: /contact (src/app/contact/actions.ts, sendContactMessageAction) is open
-- to anyone, so its rows land in support_messages with user_id null. That null
-- is load-bearing: it is how the team tells an anonymous /contact message apart
-- from a signed-in homeowner's Help message (0021), so it stays null forever.
-- But most people who write in already have an account, and today the team has
-- to hunt for it by hand. This records a best-effort guess alongside the
-- message instead of making the visitor prove anything: no account is
-- required, nothing is rejected, and the visitor sees the identical
-- confirmation either way.
--
-- TRUST LEVEL: the match is an UNVERIFIED triage hint. Anyone can type someone
-- else's email or phone into a public form, so matched_user_id is a "start
-- looking here" pointer for a human, never proof of identity. The team must
-- never disclose account details or act on account state (billing, plan,
-- cancellation, password) based on it alone.
--
-- WHAT CHANGES:
--   1. support_messages gains two nullable columns: matched_user_id (uuid,
--      references auth.users, on delete set null so a deleted account leaves
--      the message readable) and matched_via ('email', 'phone', or 'both',
--      CHECK-constrained). Both null for every existing row and for every
--      message with no match, which is the normal case.
--   2. New SECURITY DEFINER function match_support_contact(text, text),
--      service_role only (0068's rate_limit_hit grant pattern). It reads
--      auth.users, which no client role may touch, hence SECURITY DEFINER and
--      hence the revoke: anon/authenticated calling this would be an account
--      enumeration oracle.
--
-- GRACEFUL DEGRADATION: sendContactMessageAction logs and inserts without a
-- match on any RPC error, so on a database this migration has not reached yet
-- the contact form keeps working exactly as it does now.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded DO block for the CHECK
-- constraint (0114's convention), CREATE OR REPLACE for the function. Safe to
-- re-run.
-- =============================================================================

-- ---- 1. New columns ----------------------------------------------------------
alter table public.support_messages
  add column if not exists matched_user_id uuid
  references auth.users (id) on delete set null;
alter table public.support_messages
  add column if not exists matched_via text;

comment on column public.support_messages.matched_user_id is
  'UNVERIFIED triage hint only: an account whose email or phone matches what '
  'the sender typed into the public /contact form. Anyone can type someone '
  'else''s contact details, so this is never proof of identity - never '
  'disclose account details or act on account state based on it. user_id '
  'stays null on these rows; that null is what marks a message anonymous.';
comment on column public.support_messages.matched_via is
  'Which field produced matched_user_id: email, phone, or both. Null whenever '
  'matched_user_id is null.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'support_messages_matched_via_valid'
      and conrelid = 'public.support_messages'::regclass
  ) then
    alter table public.support_messages
      add constraint support_messages_matched_via_valid
      check (matched_via is null or matched_via in ('email', 'phone', 'both'));
  end if;
end $$;

create index if not exists support_messages_matched_user_id_idx
  on public.support_messages (matched_user_id)
  where matched_user_id is not null;

-- ---- 2. match_support_contact ------------------------------------------------
-- Best effort lookup of the account behind a contact-form submission. Returns
-- at most one row; no row at all means no match, which the caller treats the
-- same as an error (store the message with no match).
--
-- WHERE ACCOUNT CONTACT DETAILS ACTUALLY LIVE in this schema:
--   auth.users.email / auth.users.phone          - the identity of record
--   public.users.email / public.users.phone      - the 0001 signup mirror
--   public.contractors.contact_email / .contact_phone (user_id not null)
--                                                - a pro's business details
-- public.users is only written by handle_new_user() at signup and is never
-- re-synced on an email change (0095 makes the same point), so it can be
-- stale; it is still checked, because a stale old address still points at the
-- right person for triage. Deliberately NOT matched: pro_clients.phone/email
-- and contractor_leads.homeowner_email/homeowner_phone. Those describe a pro's
-- own customer or a job snapshot, not a Hearth account, and 0053 / 0049 keep
-- them walled off on purpose.
--
-- MATCH RULES: email compares lower(btrim()) both sides; phone compares
-- digits-only last 10 (so "(714) 555-0100", "+1 714 555 0100" and
-- "7145550100" are the same number) and a number with fewer than 10 digits is
-- treated as unusable rather than matched loosely. Email wins ties: if the
-- email and the phone point at DIFFERENT accounts, the email account is
-- recorded and matched_via is 'email', because email is the field an account
-- is actually keyed on. 'both' only when the two agree.
--
-- No index supports the phone comparisons (they are computed), so these are
-- sequential scans. That is fine here: this runs once per contact-form
-- submission, behind the 5-per-hour-per-IP rate limit the action already
-- applies, on tables in the thousands of rows.
create or replace function public.match_support_contact(
  p_email text, p_phone text
) returns table (
  user_id     uuid,
  matched_via text
) language plpgsql security definer set search_path = public as $$
declare
  v_email     text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_digits    text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_phone     text;
  v_email_uid uuid;
  v_phone_uid uuid;
begin
  if length(v_digits) >= 10 then
    v_phone := right(v_digits, 10);
  end if;

  if v_email is not null then
    select u.id into v_email_uid
    from auth.users u
    where lower(btrim(u.email)) = v_email
    order by u.created_at
    limit 1;

    if v_email_uid is null then
      select pu.id into v_email_uid
      from public.users pu
      where lower(btrim(pu.email)) = v_email
      order by pu.created_at
      limit 1;
    end if;

    if v_email_uid is null then
      select c.user_id into v_email_uid
      from public.contractors c
      where c.user_id is not null
        and lower(btrim(c.contact_email)) = v_email
      order by c.created_at
      limit 1;
    end if;
  end if;

  if v_phone is not null then
    select u.id into v_phone_uid
    from auth.users u
    where u.phone is not null
      and right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 10) = v_phone
      and length(regexp_replace(u.phone, '[^0-9]', '', 'g')) >= 10
    order by u.created_at
    limit 1;

    if v_phone_uid is null then
      select pu.id into v_phone_uid
      from public.users pu
      where pu.phone is not null
        and right(regexp_replace(pu.phone, '[^0-9]', '', 'g'), 10) = v_phone
        and length(regexp_replace(pu.phone, '[^0-9]', '', 'g')) >= 10
      order by pu.created_at
      limit 1;
    end if;

    if v_phone_uid is null then
      select c.user_id into v_phone_uid
      from public.contractors c
      where c.user_id is not null
        and c.contact_phone is not null
        and right(regexp_replace(c.contact_phone, '[^0-9]', '', 'g'), 10) = v_phone
        and length(regexp_replace(c.contact_phone, '[^0-9]', '', 'g')) >= 10
      order by c.created_at
      limit 1;
    end if;
  end if;

  if v_email_uid is not null then
    user_id := v_email_uid;
    -- 'both' only when the phone landed on the SAME account. A phone pointing
    -- somewhere else is dropped, not recorded: two half-signals would read as
    -- stronger than the one signal actually worth trusting.
    matched_via := case when v_phone_uid = v_email_uid then 'both' else 'email' end;
    return next;
  elsif v_phone_uid is not null then
    user_id := v_phone_uid;
    matched_via := 'phone';
    return next;
  end if;

  return;
end; $$;

revoke all on function public.match_support_contact(text, text)
  from public, anon, authenticated;
grant execute on function public.match_support_contact(text, text) to service_role;

comment on function public.match_support_contact(text, text) is
  'Best effort account lookup for a public /contact submission. Returns at '
  'most one row (user_id, matched_via). UNVERIFIED: anyone can type another '
  'person''s email or phone, so the result is a triage hint, never proof of '
  'identity. service_role only - it reads auth.users, so exposing it to anon '
  'or authenticated would be an account enumeration oracle.';
