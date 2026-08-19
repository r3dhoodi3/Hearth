import { describe, expect, it } from "vitest";
import {
  bonusAvailableCents,
  closedLeadIdSet,
  photoUrlsByLead,
  totalSpentCents,
  walletQueryPlan,
} from "@/lib/proDashboard";

describe("walletQueryPlan", () => {
  it("skips every wallet-derived read when there is no wallet", () => {
    expect(walletQueryPlan(null, 0)).toEqual({
      grants: false,
      applications: false,
      transactions: false,
    });
    expect(walletQueryPlan(undefined, 500)).toEqual({
      grants: false,
      applications: false,
      transactions: false,
    });
  });

  it("skips the grant lookup when there is no bonus to reconcile", () => {
    const plan = walletQueryPlan({ id: "w1" }, 0);
    expect(plan.grants).toBe(false);
    expect(plan.applications).toBe(true);
    expect(plan.transactions).toBe(true);
  });

  it("asks for grants only with a wallet id and a positive bonus", () => {
    expect(walletQueryPlan({ id: "w1" }, 1).grants).toBe(true);
    // A wallet row with no id can't key the grants/transactions queries.
    expect(walletQueryPlan({ id: null }, 1)).toEqual({
      grants: false,
      applications: true,
      transactions: false,
    });
  });
});

describe("closedLeadIdSet", () => {
  it("keeps only the leads the homeowner closed", () => {
    const ids = closedLeadIdSet([
      { id: "a", owner_closed_at: "2026-08-01T00:00:00Z" },
      { id: "b", owner_closed_at: null },
      { id: "c" },
    ]);
    expect([...ids]).toEqual(["a"]);
  });

  it("fails open on a missing lookup", () => {
    expect(closedLeadIdSet(null).size).toBe(0);
    expect(closedLeadIdSet(undefined).size).toBe(0);
    expect(closedLeadIdSet([]).size).toBe(0);
  });
});

describe("bonusAvailableCents", () => {
  it("caps the wallet counter at the live grant sum", () => {
    expect(
      bonusAvailableCents(5000, [
        { remaining_cents: 1000 },
        { remaining_cents: 500 },
      ])
    ).toBe(1500);
  });

  it("never inflates the counter above what the wallet says", () => {
    expect(bonusAvailableCents(1000, [{ remaining_cents: 9999 }])).toBe(1000);
  });

  it("drops to zero when every grant has expired away", () => {
    expect(bonusAvailableCents(2500, [])).toBe(0);
    expect(bonusAvailableCents(2500, null)).toBe(0);
  });

  it("passes a zero counter straight through", () => {
    expect(bonusAvailableCents(0, [{ remaining_cents: 800 }])).toBe(0);
  });

  it("tolerates string and null cent values from the DB", () => {
    expect(
      bonusAvailableCents(5000, [{ remaining_cents: "300" }, { remaining_cents: null }])
    ).toBe(300);
  });
});

describe("photoUrlsByLead", () => {
  const rows = [
    { related_id: "i1", url: "a.jpg" },
    { related_id: "i1", url: "b.jpg" },
    { related_id: "i2", url: "c.jpg" },
  ];

  it("groups photos under the lead that owns the issue", () => {
    const map = photoUrlsByLead(
      [
        { id: "lead1", issue_id: "i1" },
        { id: "lead2", issue_id: "i2" },
      ],
      rows
    );
    expect(map.get("lead1")).toEqual(["a.jpg", "b.jpg"]);
    expect(map.get("lead2")).toEqual(["c.jpg"]);
  });

  it("omits leads with no issue, no photos, or no rows at all", () => {
    const map = photoUrlsByLead(
      [
        { id: "lead1", issue_id: null },
        { id: "lead2", issue_id: "i9" },
      ],
      rows
    );
    expect(map.size).toBe(0);
    expect(photoUrlsByLead([{ id: "lead1", issue_id: "i1" }], null).size).toBe(0);
  });

  it("drops empty urls rather than rendering a blank photo", () => {
    const map = photoUrlsByLead(
      [{ id: "lead1", issue_id: "i1" }],
      [
        { related_id: "i1", url: "" },
        { related_id: "i1", url: null },
      ]
    );
    expect(map.size).toBe(0);
  });
});

describe("totalSpentCents", () => {
  it("sums only genuine spend types, as a positive number", () => {
    expect(
      totalSpentCents([
        { type: "apply_fee", cash_delta_cents: -2500, bonus_delta_cents: 0 },
        { type: "lead_charge", cash_delta_cents: 0, bonus_delta_cents: -1000 },
        { type: "deposit", cash_delta_cents: 20000, bonus_delta_cents: 2000 },
      ])
    ).toBe(3500);
  });

  it("counts direct unlocks and post-ghost re-charges too", () => {
    expect(
      totalSpentCents([
        { type: "direct_unlock", cash_delta_cents: -1500, bonus_delta_cents: 0 },
        { type: "ghost_recharge", cash_delta_cents: -500, bonus_delta_cents: -500 },
      ])
    ).toBe(2500);
  });

  it("ignores negative rows that are not spend", () => {
    // An expired bonus and a chargeback reversal are both negative, but a pro
    // never "spent" them: they must not inflate the total.
    expect(
      totalSpentCents([
        { type: "apply_fee", cash_delta_cents: -2500, bonus_delta_cents: 0 },
        { type: "bonus_expiry", cash_delta_cents: 0, bonus_delta_cents: -1000 },
        { type: "chargeback_reversal", cash_delta_cents: -20000, bonus_delta_cents: 0 },
      ])
    ).toBe(2500);
  });

  it("treats a mixed spend row by its net effect", () => {
    // A bonus-funded apply that also touches cash is spending.
    expect(
      totalSpentCents([
        { type: "apply_fee", cash_delta_cents: -100, bonus_delta_cents: -4900 },
      ])
    ).toBe(5000);
  });

  it("returns zero for an empty or missing ledger", () => {
    expect(totalSpentCents([])).toBe(0);
    expect(totalSpentCents(null)).toBe(0);
    expect(totalSpentCents(undefined)).toBe(0);
  });
});
