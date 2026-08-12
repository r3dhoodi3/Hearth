-- =============================================================================
-- Hearth - homeowner referral rails v1 (0100)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: a pro-refers-pro program already exists (0044/0088/0089 +
-- contractors.referred_by), but homeowners had no way to invite each other.
-- This adds the two columns that back a plain, neighbor-to-neighbor invite:
--   users.referral_code - a short, unambiguous slug that identifies the
--     inviter in a share link (/homeowner-signup?ref=CODE). Generated LAZILY
--     by application code the first time a homeowner actually asks for their
--     link (src/lib/referralCode.ts), not backfilled here - most rows stay
--     null until their owner shares something.
--   users.referred_by - set ONCE, at most, when a brand-new homeowner claims
--     their first home through someone's invite link (claimPropertyAction in
--     src/app/onboarding/actions.ts). Never overwritten, never self.
--
-- SCOPE: v1 is pure sharing. There is deliberately NO reward, credit, wallet,
-- or payout table here and none is planned for v1 - referred_by is an honest
-- attribution record and nothing more. If a reward program is ever added it
-- gets its own migration and its own review; this one must not be read as a
-- foundation for payouts.
--
-- RLS: no new policies. The existing "users self select" / "users self update"
-- policies (0002) already let a homeowner read and write their OWN row, which
-- is all a homeowner ever does with these columns. The two cross-user touches
-- both run with elevated privilege and bypass RLS entirely: resolving someone
-- else's referral_code to attribute a signup, and the public invite-card OG
-- route, both use the service-role admin client. A homeowner can technically
-- set their own referred_by directly (the self-update policy has no column
-- restriction), but with no reward attached in v1 that is harmless vanity;
-- the admin-side attribution below is the only writer that matters and it
-- guards against overwrite and self-referral.
--
-- Safe to re-run.
-- =============================================================================

alter table public.users
  add column if not exists referral_code text;

alter table public.users
  add column if not exists referred_by uuid references public.users(id);

comment on column public.users.referral_code is
  'Short, unambiguous invite slug (8 chars, no 0/O/1/I) identifying this '
  'homeowner in a share link. Generated lazily by app code on first use '
  '(src/lib/referralCode.ts); null until then. v1: pure sharing, no reward.';

comment on column public.users.referred_by is
  'The homeowner whose invite link this user signed up through, set at most '
  'once on first home claim (never overwritten, never self). Honest '
  'attribution only - v1 carries no reward or payout.';

-- Unique, but nullable: a partial unique index lets the many not-yet-generated
-- rows keep their null referral_code (Postgres treats nulls as distinct in a
-- plain unique index too, but the explicit WHERE keeps the index small and the
-- intent obvious) while guaranteeing no two homeowners ever share a code.
create unique index if not exists users_referral_code_key
  on public.users (referral_code)
  where referral_code is not null;

-- Fast reverse lookup ("who did this user refer") if it is ever needed; also
-- keeps the FK's own maintenance cheap.
create index if not exists users_referred_by_idx
  on public.users (referred_by);
