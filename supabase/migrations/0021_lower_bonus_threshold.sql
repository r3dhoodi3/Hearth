-- =============================================================================
-- Hearth - lower the deposit-bonus entry threshold (0020)
--
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase Dashboard -> SQL Editor).
--
-- Same bonus percentages, recalibrated thresholds. The bonus is a prepay
-- incentive, so the entry tier is set to ~4 mid-tier leads ($50) of credit so a
-- pro buying just 1-2 leads does NOT auto-earn a discount (which would just
-- erode the take rate), while still being more accessible than the old $250:
--     was   $250 -> 10%,  $500 -> 15%,  $1000 -> 20%   (min bonus $250)
--     now   $200 -> 10%,  $400 -> 15%,  $800  -> 20%    (min bonus $200)
--
-- Safe to re-run.
-- =============================================================================

update public.wallet_config
   set min_bonus_deposit_cents = 20000   -- $200
 where id = 1;

delete from public.deposit_tiers;
insert into public.deposit_tiers (min_cents, max_cents, bonus_pct) values
  (20000, 39999::bigint, 10),   -- $200 - $399.99
  (40000, 79999::bigint, 15),   -- $400 - $799.99
  (80000, null::bigint,  20);   -- $800+
