import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Migration 0149 (Pro members get 10% off every lead fee, never stacked with
// the aging markdown) can't be exercised from a unit test: it's a SECURITY
// DEFINER function, two pure SQL helpers and a CHECK constraint, all of which
// only exist inside Postgres. Same approach and the same limits as
// src/lib/blocks0138.test.ts and src/lib/hardening0132.test.ts: reading the
// SQL as text pins the shape (the member predicate, the never-stack rule, and
// that every OTHER guard in apply_to_lead survived the re-create byte for
// byte), it is not a substitute for running it against the live database. See
// the migration's own VERIFY section and the PASTE-ME file for the queries
// that do that.

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const MIGRATION = "supabase/migrations/0149_pro_lead_discount.sql";
const PASTE_ME = "supabase/PASTE-ME-live-2026-08-30-pro-lead-discount.sql";

const sql = read(MIGRATION);

// The body of one function, from its CREATE to its closing $$;.
function bodyOf(text: string, name: string): string {
  const start = text.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = text.indexOf("$$;", start);
  expect(end, name).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("migration 0149: the member/aging pricing helpers", () => {
  it("is_pro_member mirrors isLiveProPlanRow's predicate: pro_ plan, active or trialing, not past a known period end", () => {
    const body = bodyOf(sql, "is_pro_member");
    expect(body).toContain("s.plan like 'pro\\_%' escape '\\'");
    expect(body).toContain("s.status in ('active', 'trialing')");
    expect(body).toContain(
      "(s.current_period_end is null or s.current_period_end > now())"
    );
  });

  it("lead_aging_pct keeps the same 15%-at-3-days / 30%-at-7-days tiers as lead_fee_cents (0031)", () => {
    const body = bodyOf(sql, "lead_aging_pct");
    expect(body).toContain("now() - p_created >= interval '7 days' then 30");
    expect(body).toContain("now() - p_created >= interval '3 days' then 15");
  });

  it("pro_lead_fee_cents takes the BIGGER percent (greatest), never the sum of both", () => {
    const body = bodyOf(sql, "pro_lead_fee_cents");
    expect(body).toContain("greatest(");
    expect(body).toContain("public.lead_aging_pct(p_created)");
    expect(body).toContain("case when p_is_member then 10 else 0 end");
    // A stacking bug would read as adding the two percents (or the two
    // resulting cents) together; the actual rule takes the greater of the two
    // percents inside one multiplication, so there is exactly one "+" and it
    // is not between the two discount terms.
    expect(body).not.toMatch(/lead_aging_pct\([^)]*\)\s*\+/);
  });
});

describe("migration 0149: apply_to_lead", () => {
  const body = bodyOf(sql, "apply_to_lead");

  it("prices with the member-aware helper instead of the old aging-only one", () => {
    expect(body).toContain(
      "v_price := public.pro_lead_fee_cents(v_payout, v_created, v_is_member);"
    );
    expect(body).toContain("v_is_member := public.is_pro_member(auth.uid());");
  });

  it("the intro price is still a fixed floor: overwrites the price and the discount kind only when it undercuts the member/aging price, never further discounts it", () => {
    expect(body).toContain("v_price_before_intro := v_price;");
    expect(body).toContain(
      "v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);"
    );
    expect(body).toContain("if v_price < v_price_before_intro then");
    expect(body).toContain("v_discount_kind := 'intro';");
  });

  it("stores which single discount applied on the application row", () => {
    expect(body).toContain(
      "insert into lead_applications (lead_id, contractor_id, message, status, fee_cents, discount_kind)"
    );
    expect(body).toContain(
      "values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price, v_discount_kind);"
    );
  });

  it("keeps every other guard from 0138's body verbatim: chargeback freeze, Orange County gate, applicant cap, block gate, relationship guard, launch city gate", () => {
    for (const guard of [
      "if public.has_open_chargeback(v_contractor) then",
      "raise exception 'Confirm the cities you serve in your profile before applying to jobs';",
      "raise exception 'Job is full';",
      "if v_owner is not null and public.blocked_between(auth.uid(), v_owner) then",
      "raise exception 'Already working with this homeowner';",
      "raise exception 'This job is outside the cities you serve. Update your service area in your profile.';",
    ]) {
      expect(body, guard).toContain(guard);
    }
  });

  it("still serializes on the wallet row FOR UPDATE before any debit", () => {
    const walletLock = body.indexOf(
      "select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus"
    );
    const pricing = body.indexOf("v_price := public.pro_lead_fee_cents(");
    const debit = body.indexOf("update wallets");
    expect(pricing).toBeGreaterThan(-1);
    expect(walletLock).toBeGreaterThan(pricing);
    expect(debit).toBeGreaterThan(walletLock);
  });
});

describe("migration 0149: lead_applications.discount_kind", () => {
  it("is a nullable text column, checked to the three known kinds", () => {
    expect(sql).toContain(
      "alter table public.lead_applications\n  add column if not exists discount_kind text;"
    );
    expect(sql).toContain(
      "check (discount_kind is null or discount_kind in ('member', 'aging', 'intro'))"
    );
  });
});

describe("migration 0149: precheck guard", () => {
  it("refuses to run when a prerequisite object is missing, before touching anything", () => {
    expect(sql).toContain("-- ---- PRECHECK:");
    expect(sql).toMatch(/raise exception 'PRECHECK:.*blocked_between/);
    expect(sql).toMatch(/raise exception 'PRECHECK:.*major_lead_price_cents/);
    expect(sql).toMatch(/raise exception 'PRECHECK:.*subscriptions\.plan/);
  });
});

// The live-DB paste twin exists and carries the same helpers.
describe("supabase/PASTE-ME-live-2026-08-30-pro-lead-discount.sql", () => {
  it("exists", () => {
    expect(existsSync(repoFile(PASTE_ME))).toBe(true);
  });

  it("carries the same three pricing helpers and the re-created apply_to_lead", () => {
    const paste = read(PASTE_ME);
    for (const name of ["is_pro_member", "lead_aging_pct", "pro_lead_fee_cents", "apply_to_lead"]) {
      expect(paste, name).toContain(`create or replace function public.${name}(`);
    }
    expect(paste).toContain("add column if not exists discount_kind text");
  });
});
