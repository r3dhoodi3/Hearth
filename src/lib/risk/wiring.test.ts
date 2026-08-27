import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source-pattern tests, the same shape src/lib/aiGuard.test.ts and
// src/lib/aiUsage.test.ts use. The subjects here are server actions, a route
// handler and a SQL file: none of them can be imported into a unit test (the
// actions pull in "server-only" through the service-role client, and SQL is not
// code we can run here), so these assert against the source text instead.
//
// They are worth having anyway, because what they pin is the thing that would
// silently stop working: a checkout that forgets to ask the risk layer still
// compiles, still passes every other test, and simply hands out free trials
// forever.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const plusAction = src("../../app/(app)/plus/actions.ts");
const proAction = src("../../app/pro/plus/actions.ts");
const webhook = src("../../app/api/stripe/webhook/route.ts");
const migration = src("../../../supabase/migrations/0130_account_risk.sql");

// The three tables migration 0130 creates. Every assertion below runs against
// all three, because a lock that holds for two of them is not a lock.
const RISK_TABLES = [
  "account_signals",
  "account_risk",
  "abuse_flags",
  "risk_overrides",
];

describe("both checkout actions consult trialDecision before creating a session", () => {
  const cases: Array<[string, string, string]> = [
    ["homeowner Plus", plusAction, "startPlusCheckoutAction"],
    ["Hearth Pro", proAction, "startProCheckoutAction"],
  ];

  it.each(cases)("%s imports the risk decision", (_label, source) => {
    expect(source).toMatch(
      /import\s*\{[^}]*trialDecision[^}]*\}\s*from\s*"@\/lib\/risk\/decision"/
    );
  });

  it.each(cases)("%s calls trialDecision", (_label, source) => {
    expect(source).toContain("await trialDecision(");
  });

  it.each(cases)(
    "%s calls trialDecision BEFORE stripe.checkout.sessions.create",
    (_label, source) => {
      const decisionAt = source.indexOf("await trialDecision(");
      const sessionAt = source.indexOf("stripe.checkout.sessions.create");
      expect(decisionAt).toBeGreaterThan(-1);
      expect(sessionAt).toBeGreaterThan(-1);
      // A decision taken after the session is created is a decision that
      // changed nothing: the trial is already granted by then.
      expect(decisionAt).toBeLessThan(sessionAt);
    }
  );

  it.each(cases)(
    "%s decides BEFORE it records, so the page and the action agree",
    (_label, source) => {
      const decisionAt = source.indexOf("await trialDecision(");
      const recordAt = source.indexOf("await recordRequestSignals(");
      expect(decisionAt).toBeGreaterThan(-1);
      expect(recordAt).toBeGreaterThan(-1);
      // The /plus pages compute the SAME decision with persist:false and record
      // nothing. If the action recorded first it would decide over a strictly
      // larger set of stored signals, and the disclosure the buyer consented to
      // on the page could disagree with what Stripe then did.
      expect(decisionAt).toBeLessThan(recordAt);
    }
  );

  it.each(cases)("%s refuses checkout on allowCheckout false", (_label, source) => {
    expect(source).toContain("if (!risk.allowCheckout)");
    expect(source).toContain("RISK_BLOCK_MESSAGE");
  });

  it.each(cases)("%s gates the trial on allowTrial", (_label, source) => {
    expect(source).toContain("risk.allowTrial");
    // The gate has to feed the SAME `freeTrial` the Stripe call, the consent
    // record and the acknowledgment all read, not a parallel variable.
    expect(source).toMatch(/const freeTrial =[^\n]*risk\.allowTrial/);
  });

  it.each(cases)("%s records a signal at checkout time", (_label, source) => {
    expect(source).toMatch(/await recordRequestSignals\(user\.id, "\w+"\)/);
  });

  it("never names the signal in the refusal copy", () => {
    // Whatever the message says, it must not tell a farmer which lever moved.
    const decision = src("./decision.ts");
    const message = /RISK_BLOCK_MESSAGE =\s*\n?\s*"([^"]+)"/.exec(decision)?.[1];
    expect(message).toBeTruthy();
    // Whole words only: "membership" legitimately contains "ip".
    for (const leak of ["card", "device", "ip", "email", "score", "risk", "fraud"]) {
      expect(message!.toLowerCase()).not.toMatch(
        new RegExp(`\\b${leak}s?\\b`)
      );
    }
  });
});

describe("the pro checkout handles a Stripe failure like the homeowner one", () => {
  // Regression guard. This catch used to `throw err`, which surfaced as a 500
  // and the generic error boundary for what is usually a transient Stripe
  // hiccup, while the homeowner path flashed a sentence and redirected.
  const catchBlock = proAction.slice(
    proAction.indexOf("stripe.checkout.sessions.create")
  );

  it("does not rethrow out of the session-create catch", () => {
    // `throw err` anywhere after the session create means the rethrow is back.
    expect(catchBlock).not.toMatch(/^\s*throw err;/m);
  });

  it("logs the real Stripe error so it reaches the Vercel logs", () => {
    expect(catchBlock).toContain(
      'console.error("Pro checkout session create failed:", err)'
    );
  });

  it("flashes the same sentence the homeowner path uses and redirects", () => {
    expect(catchBlock).toContain(
      'await setFlash("We couldn\'t start checkout. Please try again.", "error")'
    );
    expect(catchBlock).toContain('redirect("/pro/plus")');
    // The homeowner action is where that sentence comes from; if one is
    // reworded the other has to be too.
    expect(plusAction).toContain(
      'await setFlash("We couldn\'t start checkout. Please try again.", "error")'
    );
  });

  it("still releases the promo reservation before redirecting", () => {
    expect(catchBlock).toContain('.eq("promo_key", "pro_intro_monthly")');
  });
});

describe("the Stripe webhook feeds the abuse signals", () => {
  it("records the card fingerprint on checkout completion, both sides", () => {
    expect(webhook).toContain(
      'recordSubscriptionCard(meta.user_id, subscription, "pro_checkout")'
    );
    expect(webhook).toContain(
      'recordSubscriptionCard(meta.user_id, subscription, "plus_checkout")'
    );
  });

  it("records the card fingerprint on a paid invoice", () => {
    expect(webhook).toContain("recordCardFromSubscriptionId(");
    expect(webhook).toContain('"invoice_paid"');
  });

  it("flags a cancellation inside the free trial ONLY with corroboration", () => {
    expect(webhook).toContain("cancelledInTrial");
    expect(webhook).toMatch(/flagAbuse\(\s*\n?\s*existing\.user_id,\s*\n?\s*"trial_abuse"/);
    // Cancelling inside the trial is what the product tells people they may do,
    // so it is not evidence on its own. The account has to have looked like a
    // farm for some other reason first.
    expect(webhook).toContain(
      "trial cancelled with no corroborating signal, not flagging"
    );
  });

  it("re-runs the score once the card is known, and can end the trial", () => {
    // The one hole that mattered: the card is the strongest signal in the table
    // and Stripe only reveals it AFTER checkout, so it could never reach the
    // decision it was written for.
    expect(webhook).toContain("endTrialIfRisky(");
    expect(webhook).toContain("computeRisk(");
    expect(webhook).toContain('stripe.subscriptions.update(subscription.id, { trial_end: "now" })');
  });

  it("guards the trial-end against a redelivered event", () => {
    expect(webhook).toContain("claimRiskEvent(");
    expect(webhook).toContain("processed_stripe_events");
    expect(webhook).toContain("`risk:${eventId}`");
  });

  it("tells the buyer when it ends their trial early", () => {
    // Silently converting somebody's free trial into a charge would be the one
    // genuinely indefensible thing this system could do.
    expect(webhook).toContain("membership starts today");
    expect(webhook).toContain("billingTermsText(plan, false)");
  });

  it("respects the log-only switch", () => {
    expect(webhook).toContain("riskEnforcementEnabled()");
    expect(webhook).toContain("would end trial (log-only mode)");
  });

  it("flags a chargeback, on dispute.created only", () => {
    expect(webhook).toContain('if (event.type === "charge.dispute.created")');
    expect(webhook).toContain("flagChargebackForCharge(");
    expect(webhook).toMatch(/flagAbuse\([^)]*"chargeback"/);
  });
});

describe("migration 0130 locks the three risk tables down", () => {
  it("creates the manual override table too", () => {
    // The whole admin surface: one hand-written row, checked before the score.
    expect(migration).toContain("create table if not exists public.risk_overrides");
    expect(migration).toContain(
      "alter table public.risk_overrides enable row level security"
    );
    expect(migration).toContain(
      "revoke all on public.risk_overrides from anon, authenticated"
    );
  });

  it("windows IP links to 7 days on both sides of the join", () => {
    // Without this, a DHCP address recycled a year ago links two strangers
    // forever, and a carrier NAT egress links thousands of them.
    const body = migration.slice(migration.indexOf("create or replace function"));
    expect(body).toContain("other.last_seen > now() - interval '7 days'");
    expect(body).toContain("mine.last_seen > now() - interval '7 days'");
  });

  it("orders links by strength so the 500-row cut is deterministic", () => {
    const body = migration.slice(migration.indexOf("create or replace function"));
    expect(body).toContain("when 'card' then 1");
    expect(body).toContain("order by l.strength");
  });

  it("stamps a salt version on every signal row", () => {
    expect(migration).toContain("salt_version smallint not null default 1");
  });

  it.each(RISK_TABLES)("creates %s", (table) => {
    expect(migration).toContain(`create table if not exists public.${table}`);
  });

  it.each(RISK_TABLES)("enables row level security on %s", (table) => {
    expect(migration).toContain(
      `alter table public.${table} enable row level security`
    );
  });

  it.each(RISK_TABLES)("revokes privileges from anon and authenticated on %s", (table) => {
    expect(migration).toContain(
      `revoke all on public.${table} from anon, authenticated`
    );
  });

  it.each(RISK_TABLES)("grants %s to service_role only", (table) => {
    expect(migration).toContain(`grant all on public.${table} to service_role`);
  });

  it("creates NO policy for authenticated or anon on any of them", () => {
    // RLS with zero policies denies everything. A policy appearing here later
    // would be the one way to quietly open these tables up, so the absence is
    // the thing worth asserting.
    expect(migration).not.toMatch(/create policy/i);
    expect(migration).not.toMatch(/to authenticated/i);
    // The one `to anon` style grant that would be a mistake.
    expect(migration).not.toMatch(/grant[^;]*to anon/i);
  });

  it("keeps linked_accounts service-role only", () => {
    expect(migration).toContain(
      "revoke all on function public.linked_accounts(uuid) from public, anon, authenticated"
    );
    expect(migration).toContain(
      "grant execute on function public.linked_accounts(uuid) to service_role"
    );
  });

  it("excludes email_domain from the link join", () => {
    // Joining on a shared email DOMAIN would link every gmail.com account to
    // every other one and return the whole user table.
    expect(migration).toContain("mine.kind <> 'email_domain'");
  });

  it("indexes the lookup the scorer actually runs", () => {
    expect(migration).toContain(
      "on public.account_signals (kind, value_hash)"
    );
  });
});

describe("the live-DB paste file matches the migration", () => {
  const paste = src(
    "../../../supabase/PASTE-ME-live-2026-08-26-account-risk.sql"
  );

  it("contains the whole migration body", () => {
    for (const table of RISK_TABLES) {
      expect(paste).toContain(`create table if not exists public.${table}`);
      expect(paste).toContain(
        `alter table public.${table} enable row level security`
      );
    }
    expect(paste).toContain("create or replace function public.linked_accounts");
  });

  it("carries verify queries for the RLS posture", () => {
    expect(paste).toContain("pg_policies");
    expect(paste).toContain("role_table_grants");
  });
});
