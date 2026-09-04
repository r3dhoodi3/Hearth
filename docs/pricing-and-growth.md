# OakTend pricing and growth playbook

This records the pricing decisions and the go-to-market plan. Numbers here are
the source of truth for what the code implements.

## 1. Per-lead fees (what a pro pays to unlock/apply for a lead)

Priced in three tiers keyed to job value and what a pro can bear (a lead is
worth only a slice of expected job profit). Benchmarked BELOW the big lead
marketplaces so OakTend undercuts them, with no annual fee.

| Tier | Fee | Trades |
|------|-----|--------|
| 1 - light / low-ticket | **$25** | cleaning, landscaping, painting, other/handyman |
| 2 - skilled / replacement | **$50** | plumbing, electrical, HVAC, windows |
| 3 - big-ticket | **$99** | roofing, structural, remodeling / general contracting |

Intro price (decided 2026-07-12): a pro's FIRST big-ticket lead ever costs
**$49.99**; every big-ticket lead after that costs the normal $99. Charged in
the DB (migration `0113_major_intro_price.sql`, `major_lead_price_cents`),
derived from the pro's own payment history, no new column. A refund does not
restore intro eligibility.

Market context (2025-26): Angi/HomeAdvisor charge roughly $15-85+ per lead PLUS
a ~$300/yr fee, roofing/HVAC/remodel at the top ($80-200 for roofing). Thumbtack
runs ~$20-75 per lead. OakTend is pay-to-apply (Thumbtack-like), so fees sit at
the accessible end and there is no annual fee, which is a concrete selling point
when recruiting pros.

Where it lives: `src/lib/constants.ts` -> `LEAD_TIER_FEES` and `LEAD_FEES`.

## 2. Deposit bonus (prepay incentive for pros)

Same percentages as before, thresholds recalibrated. The bonus is a
deposit-match that rewards prepaying a BLOCK of leads, not 1-2. If the entry
threshold is too low (e.g. $100) every pro auto-earns the bonus, which just
hands out a 10-20% discount and erodes the take rate. The entry tier is set to
about 4 mid-tier ($50) leads of credit.

| Deposit | Bonus | Approx leads prepaid |
|---------|-------|----------------------|
| $200 - $399 | **10%** | ~4-8 |
| $400 - $799 | **15%** | ~8-16 |
| $800+ | **20%** | ~16+ |

Minimum deposit to earn any bonus: **$200**. A pro buying just 1-2 leads
($50-100) pays full price, so casual/low-volume pros do not dilute margin.

Effective discount you are funding (collect cash, grant bonus credit):
- 10% tier: collect $200 for $220 of credit -> ~9.1% effective discount.
- 20% tier: collect $800 for $960 of credit -> ~16.7% effective discount.

Where it lives: `deposit_tiers` + `wallet_config.min_bonus_deposit_cents`
(migration `0020`), client fallback + copy in `DepositForm.tsx`.

## 3. Homeowner subscription (OakTend Plus)

Base app (home tracking, AI chat, document vault, proactive alerts) is FREE.
Finding/contacting pros requires OakTend Plus.

- **$9 / month** or **$59 / year** (annual saves ~45%, nudges the yearly commit).

Rationale and tradeoff: charging the demand side to access the marketplace is
unusual (most marketplaces keep demand free and monetize supply). It works here
because the free layer already delivers standalone value (the vault + AI +
alerts), so Plus gates only the high-intent "hire" moment. Watch marketplace
liquidity: if job volume drops because homeowners will not subscribe for a
one-off job, switch to a per-job connection fee (~$5-15 per posted job) instead
of a subscription. The code gates on `hasPlus()`, so swapping the gate for a
per-job charge later is a small change.

## 4. Supply seeding (fixing the marketplace cold-start)

The `contractors` table currently holds demo rows. A marketplace dies if pros
show up to an empty board or homeowners post jobs no one answers. Seed supply
BEFORE scaling demand:

1. **Pick ONE metro** (where you already have homeowner signups). Do not launch
   nationwide thin.
2. **Hand-recruit 15-25 real vetted pros** across the three tiers in that metro
   (a few roofers/GCs, several plumbers/electricians/HVAC, several
   painters/landscapers/cleaners). Cold email/call, offer free lead credit to
   start (the deposit bonus is your tool here: "deposit $200, get $220").
3. **Guarantee first-lead value**: give each new pro their first 1-2 leads free
   so they experience a real quote request before paying. This is the single
   biggest lever on pro retention.
4. **Manually match** the first weeks. When a homeowner posts a job, personally
   make sure a matching pro sees and responds fast. Liquidity feels magical when
   it is really you behind the curtain early on.
5. **Instrument the funnel**: posts -> applications -> chosen -> reviewed. The
   `post_job_from_chat` analytics event is the top of that funnel. Track
   apply-rate and time-to-first-response per metro; only expand to metro #2 once
   those are healthy.
6. **Import tooling**: keep a simple CSV (name, license, categories,
   service_area, contact) and load vetted pros via the service role. Never mark
   `vetted = true` without actually checking a license.

## 5. What the AI already does for conversion

Ask OakTend emits a `[[POSTJOB]]` block that becomes a "Get 3 free quotes" CTA.
That is your best free-advice-to-GMV path: every cost answer should end with the
option to post the job. The vault (scanning warranties/receipts/model plates) is
the retention hook and the thing a search engine cannot do for a specific home,
so push it hard in onboarding.
