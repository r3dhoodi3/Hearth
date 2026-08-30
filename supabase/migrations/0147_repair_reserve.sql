-- =============================================================================
-- Hearth - properties.repair_reserve_cents: what the owner has actually saved
-- toward the next big repair (0147)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Apply in number order
-- with no gaps: everything through 0146 first, then this.
--
-- WHY THIS EXISTS
--
-- The cost forecast (src/app/(app)/forecast/page.tsx) has always been able to
-- say "set aside about $210 a month". It has never been able to say "and you
-- are $60 a month short", because nothing in the database knows what the owner
-- has put away. That second sentence is the whole difference between a
-- projection and a plan, and it is the reason the forecast reads as a cost
-- estimator rather than something a member keeps coming back to.
--
-- WHAT THIS CHANGES
--
-- 1. Adds ONE nullable bigint column, repair_reserve_cents, on properties.
--
--    Nullable, and null is meaningful: it is "the owner has not told us",
--    which the app deliberately treats differently from "the owner has zero
--    saved" (see reservePlan() in src/lib/forecastReserve.ts - a null shows an
--    invitation, a zero shows how far behind they are). No default, so every
--    existing row starts as "not told us", which is the truth.
--
--    Cents as bigint, matching every other money column in this schema
--    (wallet_transactions.amount_cents, lead_applications.fee_cents,
--    contractor_leads.payout_amount). Never a float: a repair fund that drifts
--    by a cent per render is a support ticket waiting to happen.
--
--    Per PROPERTY, not per user, on purpose. A household with two homes has two
--    forecasts, two timelines and two reserves; hanging this off users would
--    force the two homes to share one savings figure and quietly make the
--    progress bar wrong for both.
--
-- 2. A range CHECK in the same style 0128 gave properties.address_line1 and
--    0141 gave contractors.owner_name: added NOT VALID and then validated in a
--    second statement, so the ACCESS EXCLUSIVE lock is held for the catalog
--    change only and the full-table scan runs under a weaker lock.
--
--    The floor of 0 is the real constraint: a negative repair fund is not a
--    thing, and the app's own parser (parseReserveInput) rejects one before it
--    ever gets here. The ceiling of 1,000,000,000 cents ($10,000,000) is a
--    sanity bound restated where it cannot be skipped, matching
--    RESERVE_MAX_CENTS in src/lib/forecastReserve.ts. It exists because the
--    forecast page divides by and draws a progress bar from this number: a
--    pasted 40-digit value would not corrupt anything, it would just render
--    nonsense and make the feature look broken.
--
-- 3. Column-level INSERT and UPDATE grants for `authenticated`.
--
--    READ THIS BEFORE ASSUMING IT IS THE SAME SITUATION AS 0141. It is not
--    quite. public.contractors had its TABLE-level INSERT/UPDATE revoked in
--    0085 and re-granted column by column, so a column added later WITHOUT a
--    grant is dead on arrival there. public.properties was deliberately never
--    column-locked (0095 says so in as many words: "properties has many
--    legitimate app writers... and a wrong allowlist there would break real
--    saves"), so it still holds table-level grants and this column would be
--    writable without the two lines below.
--
--    They are here anyway, and they are cheap: grants are additive, so on
--    today's schema they change nothing. What they buy is that the day someone
--    DOES column-lock properties the way 0085 locked contractors, this column
--    is already on the allowlist instead of becoming the next silent 42501 -
--    which is exactly the half-applied shape 0124 hit with launch_cities, 0128
--    hit with the review links, and 0141 hit with owner_name.
--
-- NO RLS CHANGE. repair_reserve_cents is an ordinary property column and lives
-- under the same policies address_line1 and market_value already have: the
-- owner and their household members, nobody else. It is never exposed to a
-- contractor: every pro-facing read of a home names its columns explicitly
-- (there is no `select *` over properties in any lead or public view), so
-- adding a column exposes it nowhere on its own. That matters more than usual
-- here - "how much cash this homeowner has set aside" is exactly the fact a
-- contractor should not be able to price against.
--
-- NOT ADDED TO src/lib/property.ts's PROPERTY_COLUMN_NAMES on purpose. That
-- list is one select shared by every app page, and naming a column the live
-- database does not have yet makes Postgres reject the WHOLE query with 42703,
-- which would put every page on the retry path until this migration is applied.
-- The forecast page reads this column in its own small query that degrades to
-- null on a missing-schema error instead (see isMissingSchemaError there), so
-- the page works fine on a database that has not run this file yet - the
-- reserve card simply does not offer to save anything.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, a guarded DO block for the constraint,
-- and plain GRANTs. Safe to re-run.
-- =============================================================================

alter table public.properties
  add column if not exists repair_reserve_cents bigint;

comment on column public.properties.repair_reserve_cents is
  'What the owner says they have set aside toward the next big repair on this '
  'home, in cents. Null means they have not told us, which the forecast page '
  'treats differently from zero. Per property, not per user: two homes have '
  'two timelines and two reserves. Written only by saveRepairReserveAction '
  '(src/app/(app)/forecast/actions.ts), read only by the forecast page. Never '
  'exposed to a contractor.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.properties'::regclass
      and conname = 'properties_repair_reserve_cents_range'
  ) then
    alter table public.properties
      add constraint properties_repair_reserve_cents_range
      check (
        repair_reserve_cents is null
        or (repair_reserve_cents >= 0 and repair_reserve_cents <= 1000000000)
      ) not valid;
  end if;
end
$$;

alter table public.properties
  validate constraint properties_repair_reserve_cents_range;

-- Belt and braces, not a fix for a live break. See point 3 above.
grant insert (repair_reserve_cents) on public.properties to authenticated;
grant update (repair_reserve_cents) on public.properties to authenticated;


-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- 1. The column exists, is bigint, and is nullable.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'properties'
--      and column_name = 'repair_reserve_cents';
--   -> one row: repair_reserve_cents | bigint | YES

-- 2. Every existing row starts as "not told us" (null), never 0.
--   select count(*) as total,
--          count(repair_reserve_cents) as with_a_value
--     from public.properties;
--   -> with_a_value = 0 immediately after applying this.

-- 3. The constraint exists and is validated (convalidated = true).
--   select conname, convalidated
--     from pg_constraint
--    where conrelid = 'public.properties'::regclass
--      and conname = 'properties_repair_reserve_cents_range';
--   -> one row: properties_repair_reserve_cents_range | t

-- 4. `authenticated` holds INSERT and UPDATE on the column.
--   select privilege_type
--     from information_schema.column_privileges
--    where table_schema = 'public'
--      and table_name = 'properties'
--      and column_name = 'repair_reserve_cents'
--      and grantee = 'authenticated'
--    order by privilege_type;
--   -> two rows: INSERT, UPDATE

-- 5. The check really bites. Run this against a scratch row you own, inside a
--    transaction you roll back, so nothing real is touched:
--   begin;
--     update public.properties
--        set repair_reserve_cents = -1
--      where id = '<a property uuid you own>';
--     -- expect: ERROR ... violates check constraint
--   rollback;
--
--   begin;
--     update public.properties
--        set repair_reserve_cents = 1000000001
--      where id = '<a property uuid you own>';
--     -- expect: ERROR ... violates check constraint
--   rollback;

-- 6. A legitimate value saves, and null still means "not told us".
--   begin;
--     update public.properties
--        set repair_reserve_cents = 450000
--      where id = '<a property uuid you own>';
--     select repair_reserve_cents from public.properties
--      where id = '<a property uuid you own>';
--     -- expect: 450000 (that is $4,500.00)
--   rollback;
