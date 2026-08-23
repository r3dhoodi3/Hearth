-- =============================================================================
-- Hearth - condo/townhome unit numbers on a claimed home (0127)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: properties has had exactly one address field since 0001, address_line1,
-- and it is the whole street line. A condo or townhome owner at "123 Main St
-- Unit 4" had two bad options: type the unit into address_line1, which then
-- goes to RentCast and to a pro's lead as part of the street, or leave it off
-- and be treated as the owner of the whole building. Neither is right - the
-- second is worse, because two neighbours in the same building then look like
-- the same home to every duplicate/ownership check that compares addresses.
--
-- WHAT THIS ADDS: one nullable text column. address_line1 keeps its exact
-- meaning (the street line, no unit), so nothing that reads it - the parcel
-- lookup, the assessor ownership match, the cached parcel rows - changes
-- behaviour for the single-family homes that are the overwhelming majority.
-- The unit is appended for DISPLAY only, by formatAddressLine() in
-- src/lib/property.ts.
--
-- Null vs empty string: the app writes null for "no unit", never "". A blank
-- string would make every single-family home carry a value the display helper
-- then has to special-case.
--
-- No backfill, no constraint, no index: there is nothing to migrate (every
-- existing row is unit-less by definition) and nothing looks a home up BY its
-- unit. The claim insert is written missing-column-safe (see
-- claimPropertyAction in src/app/onboarding/actions.ts), so onboarding keeps
-- working on a database that has not run this file yet - it just drops the
-- unit.
-- =============================================================================

alter table public.properties add column if not exists unit text;

comment on column public.properties.unit is
  'Condo/townhome/apartment unit designator for this home ("4B", "Apt 2", "#12"). Null for a single-family home. Kept OUT of address_line1 on purpose: address_line1 is the street line the parcel lookup and the assessor ownership match are run against, while the unit is appended for display only (formatAddressLine in src/lib/property.ts).';
