import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source test, same reason src/app/pro/page.test.tsx is one: DepositForm's
// sibling actions module pulls in the service-role Supabase client at
// import time and a full render would need to mock the whole chain for one
// className check.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const form = src("./DepositForm.tsx");
const actions = src("./actions.ts");

// Strip every max-sm:-prefixed token from a class string. What's left is
// what a desktop viewport (sm and up) actually renders, so two class lists
// with the same stripped result render identically on desktop even if one
// carries extra phone-only tokens.
function stripMaxSm(classes: string): string[] {
  return classes
    .split(/\s+/)
    .filter((c) => c.length > 0 && !c.startsWith("max-sm:"))
    .sort();
}

// CEO pass D1: the non-refundable deposit disclaimer was 12px (text-xs) with
// no phone bump, unlike the minimum-deposit line right below it which
// already had max-sm:text-sm. Now both match. 2026-08-30: both are also
// max-sm:hidden - the full text moved into the phone Details block below the
// Deposit button (see the "phone Details block" tests) so the preset buttons
// show without scrolling; on sm and up nothing here changed.
describe("pro billing: deposit disclaimer is readable on a phone", () => {
  it("carries max-sm:text-sm like the minimum-deposit line below it, and is max-sm:hidden", () => {
    expect(form).toContain(
      'className="text-xs text-stone-500 max-sm:text-sm max-sm:hidden dark:text-stone-400"'
    );
    expect(form).toContain(
      "Deposits are non-refundable and can only be spent on leads."
    );
  });

  it("does not touch the minimum-deposit line's own max-sm:text-sm rule", () => {
    // Guards against undoing the same-night D10/D11 work on this file.
    expect(form).toContain(
      'className="mt-1 text-[11px] text-stone-500 max-sm:text-sm max-sm:hidden dark:text-stone-400"'
    );
  });

  it("stripped of max-sm: tokens, both lines render exactly as they did before the phone collapse", () => {
    expect(
      stripMaxSm("text-xs text-stone-500 max-sm:text-sm max-sm:hidden dark:text-stone-400")
    ).toEqual(stripMaxSm("text-xs text-stone-500 max-sm:text-sm dark:text-stone-400"));
    expect(
      stripMaxSm(
        "mt-1 text-[11px] text-stone-500 max-sm:text-sm max-sm:hidden dark:text-stone-400"
      )
    ).toEqual(
      stripMaxSm("mt-1 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400")
    );
  });
});

// The forgone-bonus line joins the same phone collapse: max-sm:hidden, same
// desktop-visible tokens as before.
describe("pro billing: forgone-bonus line joins the phone collapse", () => {
  it("is max-sm:hidden with its desktop tokens unchanged", () => {
    expect(form).toContain(
      'className="text-xs text-stone-500 max-sm:hidden dark:text-stone-400"'
    );
    expect(
      stripMaxSm("text-xs text-stone-500 max-sm:hidden dark:text-stone-400")
    ).toEqual(stripMaxSm("text-xs text-stone-500 dark:text-stone-400"));
  });
});

// Owner's ask: on a phone, /pro/billing should not need scrolling to add
// credit. The three disclaimer paragraphs above used to sit ahead of the
// preset buttons; now they are max-sm:hidden and a single short sentence
// plus a <details> "Details" block carries the same words under the Deposit
// button instead, phone only (desktop never renders this block at all).
describe("pro billing: phone Details block replaces the disclaimers under the button", () => {
  it("sits after the Deposit button and only renders below sm", () => {
    const buttonIdx = form.indexOf("<DepositButton");
    const blockIdx = form.indexOf('<div className="hidden max-sm:block">');
    expect(buttonIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(buttonIdx);
  });

  it("carries the short always-visible sentence, no per-lead fee", () => {
    expect(form).toContain(
      "Deposits are non-refundable and spendable on leads only."
    );
    expect(form).not.toMatch(/\$\d+ (lead fee|per lead)/);
  });

  it("has a Details summary holding the full three-paragraph text", () => {
    const blockIdx = form.indexOf('<div className="hidden max-sm:block">');
    const formCloseIdx = form.indexOf("</form>");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(formCloseIdx).toBeGreaterThan(blockIdx);
    const block = form.slice(blockIdx, formCloseIdx);
    expect(block).toContain("<summary");
    expect(block).toContain("Details");
    expect(block).toContain(
      "Deposits are non-refundable and can only be spent on leads."
    );
    expect(block).toContain("Any amount from $5.");
    expect(block).toContain("without Pro leaves $");
  });
});

// MED-14: the Deposit button needs the synchronous double-submit latch (the
// same one SubmitButton carries), because useFormStatus `pending` lags a
// render and a fast double tap would otherwise fire two submits - two Stripe
// checkout sessions.
describe("pro billing: Deposit button has the double-submit latch", () => {
  it("guards on a submittedRef flipped before the pending state can catch up", () => {
    expect(form).toContain("const submittedRef = useRef(false)");
    expect(form).toContain("if (submittedRef.current)");
    expect(form).toContain("submittedRef.current = true");
    // Released on the pending -> not-pending edge, so a failed submit can retry.
    expect(form).toContain("if (!pending) submittedRef.current = false");
    // Wired onto the actual button.
    expect(form).toMatch(/onClick=\{handleClick\}/);
  });
});

// MED-14 (server half) + HIGH-30: the deposit action needs an idempotency key
// on the Stripe session create AND the three velocity/freeze guards before it.
describe("depositAction: idempotency key and velocity guards", () => {
  it("passes an idempotency key to checkout.sessions.create", () => {
    expect(actions).toContain("checkoutIdempotencyKey");
    expect(actions).toContain("{ idempotencyKey }");
  });

  it("refuses deposits while an open chargeback freezes the account", () => {
    expect(actions).toContain('rpc("has_open_chargeback"');
  });

  it("caps deposits per day and by a rolling 24h dollar ceiling", () => {
    expect(actions).toContain("DEPOSIT_MAX_PER_DAY");
    expect(actions).toContain("DEPOSIT_DAILY_CENTS_CEILING");
    expect(actions).toContain('rpc("rate_limit_hit"');
    expect(actions).toContain("deposit:${contractor.id}");
  });

  it("fails closed on the count cap: proceeds only on an explicit within-limit", () => {
    // The count cap is the guaranteed gate, so it must refuse on false/null/throw.
    expect(actions).toContain("withinCountLimit = data === true");
    expect(actions).toContain("if (!withinCountLimit)");
  });
});
