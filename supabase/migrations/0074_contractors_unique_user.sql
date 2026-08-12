-- One contractor row per user (0072). RUN AGAINST LIVE DB.
-- A non-unique index (0005) currently allows two contractor rows per user, which
-- mints two wallets and duplicates every one-time promo/referral/winback grant,
-- and crashes getCurrentContractor's .maybeSingle().
-- BEFORE applying, check for existing duplicates - this UNIQUE index will FAIL if any exist:
--   select user_id, count(*) from public.contractors where user_id is not null group by user_id having count(*) > 1;
create unique index if not exists contractors_user_id_uidx
  on public.contractors (user_id) where user_id is not null;

-- Soft dedupe signals for ops review. NON-unique on purpose: a hard uniqueness
-- constraint on phone/email would reject legitimate signups (franchises, shared
-- office lines). These exist so a human can spot clusters, not so the DB refuses.
create index if not exists contractors_contact_phone_idx
  on public.contractors (contact_phone) where contact_phone is not null;
create index if not exists contractors_contact_email_idx
  on public.contractors (lower(contact_email)) where contact_email is not null;
