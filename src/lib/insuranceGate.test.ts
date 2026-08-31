import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasCurrentInsurance,
  majorLeadInsuranceGate,
  isInsuranceGateSqlError,
  INSURANCE_REQUIRED_MESSAGE,
  INSURANCE_GATE_SQL_ERROR,
  INSURANCE_UPLOAD_HREF,
} from "./insuranceGate";

// Big-job insurance gate (migration 0153). The pure half is exercised
// directly; the SQL half is a SECURITY DEFINER function that only exists
// inside Postgres, so - same approach and same limits as
// src/lib/proLeadDiscount0149.test.ts and blocks0138.test.ts - reading the
// migration as text pins its shape (both charge functions carry the gate,
// with the raise text the actions match on, placed after each idempotent
// return and before any wallet read). It is not a substitute for running the
// migration's own VERIFY queries against the live database.

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

// Dates far enough from today that these tests never flip on a real clock.
const FUTURE = "2099-01-01";
const PAST = "2001-01-01";

describe("hasCurrentInsurance", () => {
  it("fails with nothing on file", () => {
    expect(hasCurrentInsurance(null)).toBe(false);
    expect(hasCurrentInsurance(undefined)).toBe(false);
    expect(hasCurrentInsurance("")).toBe(false);
  });

  it("passes an unexpired date, fails an expired one", () => {
    expect(hasCurrentInsurance(FUTURE)).toBe(true);
    expect(hasCurrentInsurance(PAST)).toBe(false);
  });

  it("a date expiring soon still counts as on file, matching the compliance card", () => {
    // Tomorrow classifies as "expiring" (within 30 days) on the compliance
    // card; the pro is covered today, so the gate must not refuse them.
    const tomorrow = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(hasCurrentInsurance(tomorrow)).toBe(true);
  });
});

describe("majorLeadInsuranceGate: the four verdicts", () => {
  it("major + no insurance = refused with the exact friendly message", () => {
    expect(majorLeadInsuranceGate("roof", null)).toBe(
      INSURANCE_REQUIRED_MESSAGE
    );
    expect(majorLeadInsuranceGate("structural", null)).toBe(
      INSURANCE_REQUIRED_MESSAGE
    );
    expect(majorLeadInsuranceGate("remodeling", null)).toBe(
      INSURANCE_REQUIRED_MESSAGE
    );
  });

  it("major + valid insurance = allowed", () => {
    expect(majorLeadInsuranceGate("roof", FUTURE)).toBeNull();
  });

  it("light tier + no insurance = allowed (the gate is big jobs only)", () => {
    expect(majorLeadInsuranceGate("cleaning", null)).toBeNull();
    expect(majorLeadInsuranceGate("handyman", null)).toBeNull();
    // Skilled tier is not major either.
    expect(majorLeadInsuranceGate("plumbing", null)).toBeNull();
    // Unknown/missing category can never be major.
    expect(majorLeadInsuranceGate(null, null)).toBeNull();
  });

  it("major + expired insurance = refused", () => {
    expect(majorLeadInsuranceGate("roof", PAST)).toBe(
      INSURANCE_REQUIRED_MESSAGE
    );
  });
});

describe("the copy itself", () => {
  it("is the owner-approved sentence, byte for byte", () => {
    expect(INSURANCE_REQUIRED_MESSAGE).toBe(
      "Big jobs need proof of insurance on file first. Add yours in Business > Compliance, it takes two minutes."
    );
  });

  it("the upload link goes to the compliance card's page", () => {
    expect(INSURANCE_UPLOAD_HREF).toBe("/pro/business");
  });

  it("recognizes the SQL backstop's raise text, wrapped or bare", () => {
    expect(isInsuranceGateSqlError(INSURANCE_GATE_SQL_ERROR)).toBe(true);
    expect(
      isInsuranceGateSqlError("ERROR: Insurance required for big jobs")
    ).toBe(true);
    expect(isInsuranceGateSqlError("Job is full")).toBe(false);
    expect(isInsuranceGateSqlError(null)).toBe(false);
  });
});

describe("migration 0153: the SQL backstop", () => {
  const MIGRATION = "supabase/migrations/0153_major_job_insurance_gate.sql";
  // The insurance gate ships to the live DB inside the combined pending paste
  // (0152 feedback + 0153 insurance concatenated), not a standalone file.
  const PASTE_ME = "supabase/PASTE-ME-ALL-PENDING-2026-08-31.sql";
  const sql = read(MIGRATION);

  // The body of one function, from its CREATE to its closing $$;.
  function bodyOf(text: string, name: string): string {
    const start = text.indexOf(
      `create or replace function public.${name}(`
    );
    expect(start, name).toBeGreaterThan(-1);
    const end = text.indexOf("$$;", start);
    expect(end, name).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  const GATE =
    "if v_category in ('roof', 'structural', 'remodeling')\n     and (v_insurance_expires is null or v_insurance_expires < current_date) then\n    raise exception 'Insurance required for big jobs';";

  for (const fn of ["apply_to_lead", "unlock_direct_request"]) {
    it(`${fn} carries the gate, after its idempotent return and before the wallet`, () => {
      const body = bodyOf(sql, fn);
      expect(body).toContain(GATE);
      // The raise text is exactly what the actions match on.
      expect(body).toContain(`'${INSURANCE_GATE_SQL_ERROR}'`);
      // The gate sits AFTER the idempotent already-paid return (a pro who
      // already holds the lead keeps getting true) and BEFORE the wallet is
      // even resolved (a refusal moves no money).
      const idempotent = body.indexOf("return true;");
      const gate = body.indexOf("raise exception 'Insurance required");
      const wallet = body.indexOf("get_or_create_wallet");
      expect(idempotent).toBeGreaterThan(-1);
      expect(gate).toBeGreaterThan(idempotent);
      expect(wallet).toBeGreaterThan(gate);
      // The expiry is read off the caller's own contractors row.
      expect(body).toContain("insurance_expires");
    });
  }

  it("keeps every pre-existing guard of 0149's apply_to_lead verbatim", () => {
    const body = bodyOf(sql, "apply_to_lead");
    for (const guard of [
      "if public.has_open_chargeback(v_contractor) then",
      "raise exception 'Confirm the cities you serve in your profile before applying to jobs';",
      "raise exception 'Job is full';",
      "if v_owner is not null and public.blocked_between(auth.uid(), v_owner) then",
      "raise exception 'Already working with this homeowner';",
      "v_price := public.pro_lead_fee_cents(v_payout, v_created, v_is_member);",
      "v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);",
    ]) {
      expect(body, guard).toContain(guard);
    }
  });

  it("refuses to run against an unready database (precheck before any CREATE)", () => {
    expect(sql).toContain("-- ---- PRECHECK:");
    expect(sql).toMatch(/raise exception 'PRECHECK:.*apply_to_lead/);
    expect(sql).toMatch(/raise exception 'PRECHECK:.*insurance_expires/);
    // The precheck DO block appears before either function body.
    expect(sql.indexOf("do $precheck$")).toBeLessThan(
      sql.indexOf("create or replace function")
    );
  });

  it("has a live-DB paste twin carrying both re-created functions", () => {
    expect(existsSync(repoFile(PASTE_ME))).toBe(true);
    const paste = read(PASTE_ME);
    for (const name of ["apply_to_lead", "unlock_direct_request"]) {
      expect(paste, name).toContain(
        `create or replace function public.${name}(`
      );
    }
    expect(paste).toContain(INSURANCE_GATE_SQL_ERROR);
  });
});

describe("the actions carry the same gate (source pin)", () => {
  const actions = read("src/app/pro/actions.ts");

  it("applyToJobAction gates before the RPC and translates the SQL backstop", () => {
    const gate = actions.indexOf(
      "majorLeadInsuranceGate(\n        ((leadClosedCheck as any)?.category"
    );
    const rpc = actions.indexOf('rpc("apply_to_lead"');
    expect(gate).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(gate);
    expect(actions).toContain("isInsuranceGateSqlError(error.message)");
  });

  it("unlockDirectRequestAction gates before its RPC too", () => {
    const gate = actions.indexOf(
      "majorLeadInsuranceGate(\n      (leadRow?.category"
    );
    const rpc = actions.indexOf('rpc("unlock_direct_request"');
    expect(gate).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(gate);
  });
});

describe("/pro-terms: the insurance and venue clause (source pin)", () => {
  const terms = read("src/app/pro-terms/page.tsx");

  it("requires liability insurance covering injury and property damage", () => {
    expect(terms).toContain("carry appropriate liability insurance");
    expect(terms).toContain("bodily injury and property damage");
    // Not "...on file" in one piece: JSX wraps the sentence across lines.
    expect(terms).toContain("requires current proof of insurance");
  });

  it("states the venue relationship and sole responsibility", () => {
    expect(terms).toContain(
      "Hearth is a venue that connects homeowners with independent"
    );
    expect(terms).toContain("does not perform, supervise, or guarantee the");
    expect(terms).toContain("solely responsible for the work you perform");
  });

  it("flags the clause for counsel per the repo's TODO(legal) convention", () => {
    expect(terms).toContain(
      "TODO(legal): have counsel review the insurance and venue clause wording"
    );
  });
});
