-- =============================================================================
-- Hearth - cash-first wallet charging, made explicit (0064)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Idempotent and safe to
-- re-run.
--
-- Founder's explicit rule: when a pro is charged a lead fee, take it from
-- real cash balance first and only draw promotional/bonus credit once cash
-- is at $0. Every charge path (apply_to_lead 0060, choose_applicant 0058,
-- the retired charge_lead 0059) already branches on the single
-- wallet_config.spend_cash_first flag, and that flag has defaulted to true
-- since it was introduced in 0010 - so the running behavior already matches
-- this rule. This migration exists to pin that decision explicitly (instead
-- of leaving it as an unannounced default) in case the live row was ever
-- hand-edited, and to leave a durable note for the next person who wonders
-- whether the order is intentional.
--
-- Trade-off worth knowing, not acted on here: cash-first means a pro who
-- keeps their wallet topped up with cash can let expiring bonus credit
-- (referral, win-back, first-apply-guarantee, deposit-match) sit unused and
-- have it swept to zero by expire_bonus() before it's ever spent. Within the
-- bonus bucket the drain is already soonest-expiring-first (0060:127-130),
-- so this only affects the cash-vs-bonus macro order, not which bonus grant
-- goes first once bonus IS being spent. If lost promo credit becomes a
-- support/trust problem, the fix is a merge-by-expiry across cash (treated
-- as a non-expiring tranche) and bonus_grants, not just flipping this flag
-- to bonus-first - see the research notes attached to this change for why a
-- blanket "bonus first" swap trades one problem for a smaller version of
-- the same one on very long-dated grants.
-- =============================================================================

update public.wallet_config set spend_cash_first = true where id = 1;

comment on column public.wallet_config.spend_cash_first is
  'Charge order for lead fees: true = draw real cash balance before any bonus/promo credit (founder''s explicit default, set 2026-07). Bonus credit, once reached, is still drained soonest-expiring-first within bonus_grants regardless of this flag.';
