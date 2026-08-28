import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Migration 0138 is the enforcement half of blocking, and none of it can be
// exercised from a unit test: RLS policies, a BEFORE INSERT trigger and two
// SECURITY DEFINER functions only exist inside Postgres. What CAN be checked
// here is the failure mode this repo actually has - a function re-issued
// COPY-ONLY that quietly loses a guard line added in between - plus the shape
// of the new table.
//
// Same approach and the same limits as src/lib/hardening0132.test.ts: reading
// the SQL as text is not a substitute for running it against the live
// database. See the PASTE-ME file for the queries that do that.

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const MIGRATION = "supabase/migrations/0138_user_blocks.sql";
const PASTE_ME = "supabase/PASTE-ME-live-2026-08-28-user-blocks.sql";

const sql = read(MIGRATION);

// The body of one function in the file, from its CREATE to its closing $$;.
function bodyOf(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  expect(end, name).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("migration 0138: the user_blocks table", () => {
  it("keys on a UUID and never a sequence", () => {
    expect(sql).toContain("id              uuid primary key default gen_random_uuid()");
    expect(sql).not.toMatch(/\b(serial|bigserial|identity)\b/i);
  });

  it("references auth.users on both sides and cascades a deleted account", () => {
    expect(sql).toContain(
      "blocker_user_id uuid not null references auth.users (id) on delete cascade"
    );
    expect(sql).toContain(
      "blocked_user_id uuid not null references auth.users (id) on delete cascade"
    );
  });

  it("cannot hold the same block twice, or a self-block", () => {
    expect(sql).toContain("unique (blocker_user_id, blocked_user_id)");
    expect(sql).toContain("check (blocker_user_id <> blocked_user_id)");
  });

  it("scopes all three policies to the blocker, and offers no update", () => {
    for (const verb of ["select", "insert", "delete"]) {
      expect(sql, verb).toContain(`create policy "user_blocks self ${verb}"`);
    }
    // The only clause any of them may test is blocker_user_id = auth.uid().
    // A policy on blocked_user_id would let somebody read who blocked them,
    // which is a message from a person who asked to send them none. Scoped to
    // the policy block itself: open_jobs_for_me legitimately matches on
    // blocked_user_id = auth.uid() further down.
    const policyBlock = sql.slice(
      sql.indexOf('create policy "user_blocks self select"'),
      sql.indexOf("revoke all on public.user_blocks from anon;")
    );
    expect(policyBlock.length).toBeGreaterThan(100);
    expect(policyBlock).not.toContain("blocked_user_id = auth.uid()");
    expect(
      policyBlock.match(/blocker_user_id = auth\.uid\(\)/g)?.length
    ).toBe(3);
    expect(sql).toContain("alter table public.user_blocks enable row level security;");
    expect(sql).toContain(
      "grant select, insert, delete on public.user_blocks to authenticated;"
    );
    expect(sql).toContain("revoke all on public.user_blocks from anon;");
    expect(sql).not.toContain("grant update on public.user_blocks");
  });
});

describe("migration 0138: enforcement points", () => {
  it("gates the messages insert policy AND raises a readable error in a trigger", () => {
    // The policy is the fence; the trigger is the sentence a person reads.
    expect(sql).toContain('create policy "messages insert" on public.messages');
    expect(sql).toContain("not public.lead_has_block(lead_id)");
    expect(sql).toContain("create trigger messages_block_guard");
    expect(sql).toContain("before insert on public.messages");
    expect(sql).toContain("You can no longer message this person.");
  });

  // The three bodies LeadChat actually inserts under sender_role = 'system':
  // `${CLOSE_PREFIX} by the ${role}.` once per role, and REOPEN_BODY. See
  // postSystem / confirmClose / reopen in src/components/LeadChat.tsx. If those
  // strings move, the SQL literals below have to move with them.
  const MARKERS = [
    "'Conversation closed by the homeowner.'",
    "'Conversation closed by the contractor.'",
    "'Conversation reopened.'",
  ];

  // The trigger function body, and the WITH CHECK of the messages insert
  // policy, out of any SQL text that carries both.
  const triggerOf = (text: string) => {
    const start = text.indexOf(
      "create or replace function public.enforce_message_not_blocked()"
    );
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf("$$;", start));
  };
  const messagesPolicyOf = (text: string) => {
    const start = text.indexOf('create policy "messages insert" on public.messages');
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf("\n  );", start));
  };

  it("lets the exact system markers through so a blocked thread can still be closed", () => {
    // Losing this would leave a blocked thread stuck open with no way out.
    for (const text of [triggerOf(sql), messagesPolicyOf(sql)]) {
      for (const marker of MARKERS) expect(text, marker).toContain(marker);
    }
    expect(triggerOf(sql)).toContain("new.sender_role = 'system'");
    expect(triggerOf(sql)).toContain("new.body in (");
    expect(triggerOf(sql)).toContain(") and public.lead_has_block(new.lead_id) then");
    expect(messagesPolicyOf(sql)).toContain("sender_role = 'system'");
    expect(messagesPolicyOf(sql)).toContain("and body in (");
    expect(messagesPolicyOf(sql)).toContain("or not public.lead_has_block(lead_id)");
  });

  it("does NOT exempt a system row carrying an arbitrary body", () => {
    // Red team (2026-08-28): enforce_message_sender_role (0089) only validates
    // that a 'homeowner'/'contractor' row matches who is sending, so it never
    // rejects a 'system' row. A bare `sender_role = 'system'` exemption
    // therefore let a blocked party POST
    // {"sender_role":"system","body":"anything"} at PostgREST and have it land
    // in the thread. Neither enforcement point may carry the unqualified form.
    for (const text of [sql, read(PASTE_ME)]) {
      expect(text).not.toContain("new.sender_role <> 'system' and");
      expect(text).not.toContain(
        "sender_role = 'system' or not public.lead_has_block(lead_id)"
      );
      // Every exemption is paired with a body test naming the exact markers.
      expect(triggerOf(text)).toContain("new.body in (");
      expect(messagesPolicyOf(text)).toContain("and body in (");
      for (const marker of MARKERS) {
        expect(triggerOf(text), marker).toContain(marker);
        expect(messagesPolicyOf(text), marker).toContain(marker);
      }
    }
  });

  it("keeps every existing filter on open_jobs_for_me and adds one predicate", () => {
    const body = bodyOf("open_jobs_for_me");
    // 0124's gates, all of which a careless copy would drop.
    expect(body).toContain("cl.contractor_id is null");
    expect(body).toContain("cl.status = 'new'");
    expect(body).toContain("cl.direct_to is null");
    expect(body).toContain("c.serves_orange_county = true");
    expect(body).toContain("public.launch_city_for_zip(pr.zip) = any (c.launch_cities)");
    expect(body).toContain("upper(btrim(pr.state)) = upper(btrim(c.service_state))");
    // And the new one.
    expect(body).toContain("select 1 from user_blocks b");
    // Symmetric: a block hides the board in both directions.
    expect(body).toContain("b.blocker_user_id = auth.uid() and b.blocked_user_id = pr.user_id");
    expect(body).toContain("b.blocker_user_id = pr.user_id and b.blocked_user_id = auth.uid()");
  });

  it("keeps every existing gate on apply_to_lead and adds the block gate before any money moves", () => {
    const body = bodyOf("apply_to_lead");
    // 0132's chargeback freeze, 0087's OC gate, 0124's city gate, 0060's
    // one-live-lead rule, the applicant cap: every one of them survives.
    expect(body).toContain("if public.has_open_chargeback(v_contractor) then");
    expect(body).toContain("Confirm the cities you serve in your profile before applying to jobs");
    expect(body).toContain("This job is outside the cities you serve");
    expect(body).toContain("Already working with this homeowner");
    expect(body).toContain("Job is full");
    // The new gate.
    expect(body).toContain("public.blocked_between(auth.uid(), v_owner)");
    // Vague on purpose: a pro must not learn from this that one particular
    // homeowner blocked them.
    expect(body).toContain("This job is not available to you.");
    // Before the wallet, before the debit, before the insert.
    expect(body.indexOf("blocked_between")).toBeLessThan(
      body.indexOf("get_or_create_wallet")
    );
    expect(body.indexOf("blocked_between")).toBeLessThan(
      body.indexOf("insert into lead_applications")
    );
    // After the idempotent already-applied return, so a pro who already holds
    // this lead still gets `true` rather than an error.
    expect(body.indexOf("return true;  -- idempotent: already applied")).toBeLessThan(
      body.indexOf("blocked_between")
    );
  });

  it("re-issues both functions with their signatures unchanged", () => {
    // The signature is what preserves the EXECUTE grants across CREATE OR
    // REPLACE. If either drifts, the job board goes down.
    expect(sql).toContain("create or replace function public.open_jobs_for_me()");
    expect(sql).toContain(
      "create or replace function public.apply_to_lead(p_lead uuid, p_message text)"
    );
  });

  it("keeps both helpers security definer and off limits to anon", () => {
    // Red-team A (2026-08-28): the two helpers no longer get the SAME grant.
    //
    // blocked_between is service_role ONLY. Supabase publishes every public
    // function an ordinary role may execute as a PostgREST RPC, so granting it
    // to `authenticated` turned it into a block oracle - POST two ids, get a
    // yes/no - which is precisely what the user_blocks table comment says is
    // impossible. apply_to_lead calls it as its own definer and the app calls
    // it through the service-role client, so nothing needed that grant.
    expect(sql).toContain(
      "revoke all on function public.blocked_between(uuid, uuid) from public, anon, authenticated;"
    );
    expect(sql).toContain(
      "grant execute on function public.blocked_between(uuid, uuid) to service_role;"
    );

    // lead_has_block MUST keep the authenticated grant: RLS evaluates a
    // policy's function calls as the querying role, and "messages insert"
    // calls it. Its caller check lives in the body instead - see below.
    expect(sql).toContain(
      "revoke all on function public.lead_has_block(uuid) from public, anon;"
    );
    expect(sql).toContain(
      "grant execute on function public.lead_has_block(uuid) to authenticated, service_role;"
    );
  });

  it("only answers lead_has_block for a caller who is on the lead", () => {
    const start = sql.indexOf("create or replace function public.lead_has_block(");
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf("$$;", start));
    expect(body).toContain("public.can_access_lead(p_lead)");
  });
});

describe("migration 0138: reports gains a target", () => {
  it("makes lead_id nullable and adds the two target columns", () => {
    expect(sql).toContain("alter table public.reports alter column lead_id drop not null;");
    expect(sql).toContain("add column if not exists target_type text;");
    expect(sql).toContain("add column if not exists target_id uuid;");
  });

  it("still requires a report to be about something", () => {
    expect(sql).toContain(
      "check (lead_id is not null or (target_type is not null and target_id is not null))"
    );
    expect(sql).toContain("target_type in ('review', 'contractor')");
  });

  it("keeps reporter_id = auth.uid() on every branch of the insert policy", () => {
    const start = sql.indexOf('create policy "reports insert"');
    expect(start).toBeGreaterThan(-1);
    const policy = sql.slice(start, sql.indexOf(";", sql.indexOf("with check", start)));
    expect(policy).toContain("reporter_id = auth.uid()");
    // The chat branch keeps 0009's relationship check.
    expect(policy).toContain("public.can_access_lead(lead_id)");
  });
});

describe("migration 0138: review ids", () => {
  it("drops and recreates contractor_reviews, because a return type cannot be replaced", () => {
    expect(sql).toContain("drop function if exists public.contractor_reviews(uuid);");
    expect(sql).toContain("create or replace function public.contractor_reviews(p_contractor uuid)");
    // A drop revokes the grants, so they have to be restated.
    expect(sql).toContain(
      "grant execute on function public.contractor_reviews(uuid) to anon, authenticated, service_role;"
    );
  });

  it("keeps public_pro_profile's payload intact and only adds the id", () => {
    const body = bodyOf("public_pro_profile");
    expect(body).toContain("'id',         r.id,");
    expect(body).toContain("select id, rating, comment, created_at");
    // 0132's visibility gate must survive the copy: without it, unclaimed and
    // out-of-market pros get a public, indexable business page again.
    expect(body).toContain("and c.user_id is not null");
    expect(body).toContain("and coalesce(c.serves_orange_county, false)");
    // Membership still gates only the cosmetics.
    expect(body).toContain("'logo_url',     case when m.live then c.logo_url end");
  });
});

describe("the live-DB bundle", () => {
  it("exists and carries the whole migration", () => {
    expect(existsSync(repoFile(PASTE_ME))).toBe(true);
    const paste = read(PASTE_ME);
    expect(paste).toContain("create table if not exists public.user_blocks");
    expect(paste).toContain("create or replace function public.open_jobs_for_me()");
    expect(paste).toContain(
      "create or replace function public.apply_to_lead(p_lead uuid, p_message text)"
    );
  });

  it("says what happens if it is not run, and how to verify it was", () => {
    const paste = read(PASTE_ME);
    expect(paste).toContain("NOTHING BREAKS IF YOU DELAY THIS");
    expect(paste).toContain("VERIFY");
    expect(paste).toContain("pg_policies");
  });
});
