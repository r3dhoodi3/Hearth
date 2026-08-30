import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Red team H1 (2026-08-30) proved on live that the homeowner who posted a lead
// could back-date contractor_leads.created_at through their own RLS UPDATE
// grant, and apply_to_lead prices the aging markdown (15% / 30%) off that
// column. Migration 0150 pins the column inside the lock trigger. This test
// pins the migration, so the next re-issue of enforce_contractor_leads_locked()
// cannot silently drop the two lines the way earlier re-issues dropped fields.
const root = path.resolve(__dirname, "../..");
const migration = readFileSync(
  path.join(root, "supabase/migrations/0150_pin_lead_created_at.sql"),
  "utf8"
);

describe("0150 pins contractor_leads.created_at", () => {
  it("re-issues the lock trigger function", () => {
    expect(migration).toContain(
      "create or replace function public.enforce_contractor_leads_locked()"
    );
  });

  it("forces now() on an unprivileged insert", () => {
    // Inside the `if not v_privileged` INSERT block, next to payout_amount.
    const insertBlock = migration.slice(
      migration.indexOf("if tg_op = 'INSERT' then"),
      migration.indexOf("if tg_op = 'UPDATE' then")
    );
    expect(insertBlock).toContain("new.created_at := now();");
  });

  it("restores the old value on an unprivileged update", () => {
    const updateBlock = migration.slice(migration.indexOf("if tg_op = 'UPDATE' then"));
    expect(updateBlock).toContain("new.created_at  := old.created_at;");
    // Same block that pins property_id, so the two cannot drift apart.
    expect(updateBlock.indexOf("new.created_at  := old.created_at;")).toBeGreaterThan(
      updateBlock.indexOf("new.property_id := old.property_id;")
    );
  });

  it("is the latest definition of the trigger function", () => {
    // Any later migration that re-creates the function must carry the pin too.
    const dir = path.join(root, "supabase/migrations");
    const later = require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => /^\d{4}_/.test(f) && f > "0150_")
      .filter((f: string) =>
        readFileSync(path.join(dir, f), "utf8").includes(
          "function public.enforce_contractor_leads_locked()"
        )
      );
    for (const f of later) {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect(text, f).toContain("new.created_at  := old.created_at;");
      expect(text, f).toContain("new.created_at := now();");
    }
  });

  it("ships a paste twin with the same body", () => {
    const paste = path.join(
      root,
      "supabase/PASTE-ME-live-2026-08-30-pin-lead-created-at.sql"
    );
    expect(existsSync(paste)).toBe(true);
    const text = readFileSync(paste, "utf8");
    expect(text).toContain("new.created_at  := old.created_at;");
    expect(text).toContain("PRECHECK");
  });
});
