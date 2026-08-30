import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GHOST_PROTECTION_GUARANTEE,
  FIRST_APPLICATION_GUARANTEE,
  CREDIT_NOT_CASH_LINE,
  NO_CONTRACT_LINE,
  NO_BIDDING_WARS_LINE,
  ghostProtectionGuaranteeRich,
  firstApplicationGuaranteeRich,
  creditNotCashLineRich,
} from "./guaranteeCopy";
import { LEAD_TIER_FEES, PRO_PLAN } from "./constants";

// This module has no server-only imports (constants.ts is plain data), unlike
// most of the pro-side files that read the canonical strings, so it can be
// imported directly instead of read as source text.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("ghost protection: never a bare refund, always credit-to-wallet", () => {
  it("says 'lead credit' and '(not cash)' in the sentence itself, not only in the paired CREDIT_NOT_CASH_LINE", () => {
    // Some surfaces render this line alone (see BusinessView.tsx's own inline
    // sentence below), so the "not cash" qualifier has to survive on its own.
    expect(GHOST_PROTECTION_GUARANTEE).toContain("lead credit (not cash)");
    expect(GHOST_PROTECTION_GUARANTEE).not.toMatch(/\brefund/i);
  });

  it("the *Rich helpers actually wrap the credit words in <strong>, not just bold-flavored plain text", () => {
    const ghostHtml = renderToStaticMarkup(
      createElement("span", null, ghostProtectionGuaranteeRich())
    );
    expect(ghostHtml).toContain(
      "<strong>you always get the fee back to your wallet as lead credit (not cash)</strong>"
    );

    const firstAppHtml = renderToStaticMarkup(
      createElement("span", null, firstApplicationGuaranteeRich())
    );
    expect(firstAppHtml).toContain("<strong>you get that one back as credit too</strong>");
    expect(firstAppHtml).toContain(
      "<strong>only on your very first paid application</strong>"
    );

    const creditLineHtml = renderToStaticMarkup(
      createElement("span", null, creditNotCashLineRich())
    );
    expect(creditLineHtml).toContain("<strong>Hearth credit in your wallet</strong>");
    expect(creditLineHtml).toContain("<strong>not money back to your card</strong>");
  });

  // A ghost-protection sentence that says "refund"/"refunded" without the
  // word "credit" nearby reads as a cash refund - the exact confusion the
  // owner flagged (2026-08-30). This runs the rule against every sentence
  // this file exports, and would catch a future edit that drops the
  // qualifier from any of them.
  it("no exported sentence uses 'refund' without 'credit' within 60 characters", () => {
    for (const sentence of [
      GHOST_PROTECTION_GUARANTEE,
      FIRST_APPLICATION_GUARANTEE,
      CREDIT_NOT_CASH_LINE,
    ]) {
      assertRefundPairedWithCredit(sentence);
    }
  });

  // The other surfaces that state the ghost-protection promise in their own
  // words rather than rendering the canonical sentence (LeadsBoard's pending-
  // applications note, BusinessView's, DirectRequestActions' unlock confirm).
  // Read as source, same convention as src/components/phoneTapTargets.test.ts,
  // because all three pull in client components with a server-action or
  // service-role import chain.
  it("LeadsBoard's pending-applications ghost-protection line pairs refund with credit", () => {
    const board = src("../app/pro/leads/LeadsBoard.tsx");
    const p = sliceParagraph(board, "Ghost protection: if the homeowner never responds and no one is");
    expect(p).toContain("<strong>wallet credit</strong>");
    assertRefundPairedWithCredit(p);
  });

  it("BusinessView's pending-applications ghost-protection line says lead credit, not cash", () => {
    const view = src("../app/pro/business/BusinessView.tsx");
    const p = sliceParagraph(view, "Ghost protection: if the homeowner never responds, your fee comes");
    expect(p).toContain("<strong>lead credit (not cash)</strong>");
    assertRefundPairedWithCredit(p);
  });

  it("DirectRequestActions' unlock-confirm line bolds the fee and says lead credit, not cash", () => {
    const actions = src("../app/pro/DirectRequestActions.tsx");
    const p = sliceParagraph(actions, "Unlocking accepts this request and charges the");
    expect(p).toContain("<strong>{fee}</strong>");
    expect(p).toContain("<strong>lead credit (not cash)</strong>");
    assertRefundPairedWithCredit(p);
  });
});

describe("no-contract and no-bidding-wars lines say only what is true today", () => {
  it("NO_CONTRACT_LINE names the one real optional charge (Pro membership) and says it cancels any time", () => {
    // Pro membership is real (PRO_PLAN exists, monthly and yearly) - the line
    // must not claim there is no optional charge at all, only that it is not
    // a contract.
    expect(PRO_PLAN.monthly).toBeGreaterThan(0);
    expect(PRO_PLAN.yearly).toBeGreaterThan(0);
    expect(NO_CONTRACT_LINE).toContain("Pro membership");
    expect(NO_CONTRACT_LINE).toMatch(/cancel.*any time/i);
    expect(NO_CONTRACT_LINE).not.toMatch(/\bannual fee\b/i); // an annual cadence exists; "no annual fee" alone would overclaim
  });

  it("NO_BIDDING_WARS_LINE matches the real pricing shape: one flat fee per tier", () => {
    // Truthful only because every tier really is one fixed number, not a
    // range or a bid - if LEAD_TIER_FEES ever grows a range this line and
    // this assertion both need to change together.
    for (const fee of Object.values(LEAD_TIER_FEES)) {
      expect(typeof fee).toBe("number");
    }
    expect(NO_BIDDING_WARS_LINE).toContain("one flat fee for its tier");
    expect(NO_BIDDING_WARS_LINE).toContain("shown before you tap");
  });
});

// Grabs the <p>...</p> JSX block starting at `marker`, for a scoped assertion
// instead of matching anywhere in a multi-hundred-line file.
function sliceParagraph(text: string, marker: string): string {
  const start = text.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = text.indexOf("</p>", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function assertRefundPairedWithCredit(text: string): void {
  const re = /refund\w*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const windowStart = Math.max(0, m.index - 60);
    const windowEnd = Math.min(text.length, m.index + m[0].length + 60);
    const window = text.slice(windowStart, windowEnd);
    expect(window.toLowerCase(), `"refund" without "credit" nearby: "${window}"`).toMatch(
      /credit/
    );
  }
}
