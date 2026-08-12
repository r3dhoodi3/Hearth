-- =============================================================================
-- Hearth - insurance renewal checkup
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Powers the "Home insurance" card on /documents and the renewal-nudge cron
-- (/api/cron/insurance-renewal): the homeowner copies two things off their
-- current policy, the renewal date and the annual premium. Hearth shows how
-- that premium sits next to the state's approximate average, nudges them
-- about 45 days before renewal so there is time to shop, and Plus members can
-- build a requote packet (/api/insurance-packet) to hand to insurance agents.
--
-- Both columns are owner-entered from their policy; Hearth never guesses
-- them. The existing "owner selects/updates own property" RLS policies cover
-- both columns.
--
-- Safe to re-run.
-- =============================================================================

alter table public.properties
  add column if not exists insurance_renewal_date date;

alter table public.properties
  add column if not exists insurance_premium numeric;

comment on column public.properties.insurance_renewal_date is
  'Home insurance renewal date, owner-entered from their policy. Powers the renewal nudge and the requote packet.';

comment on column public.properties.insurance_premium is
  'Annual home insurance premium in dollars, owner-entered from their policy. Powers the renewal nudge and the requote packet.';
