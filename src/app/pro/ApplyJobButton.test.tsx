// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// applyToJobAction pulls in the service-role Supabase client at module scope,
// which cannot be imported in a test process (same reasoning as
// src/app/pro/leads/LeadsBoard.test.tsx's stub of the same component's real
// neighbors). The button never actually submits in these tests, so the mock
// is never called.
vi.mock("./actions", () => ({ applyToJobAction: vi.fn() }));

import ApplyJobButton from "./ApplyJobButton";
import { bestLeadDiscount } from "@/lib/leadPricing";
import { PRO_LEAD_DISCOUNT_PCT } from "@/lib/constants";
import { money } from "@/lib/proLeadCard";

afterEach(() => cleanup());

// Whole-document substring check, deliberately NOT screen.getByText(regex):
// a regex TextMatch matches every ancestor whose full (concatenated)
// textContent contains the pattern, not just the one element that "owns" the
// text - the confirm card nests the price line inside a <p>, so a regex
// query here would hit both the <strong> and its <p> ancestor and throw
// "multiple elements found". body.textContent is one string with no such
// ambiguity.
function bodyHas(text: string): boolean {
  return document.body.textContent?.includes(text) ?? false;
}

// Confirms the confirm-step price line prints EXACTLY what bestLeadDiscount
// (migration 0149's TS mirror) computed - the same number apply_to_lead will
// actually charge, never a number the button invented on its own.
describe("ApplyJobButton: confirm copy matches the pricing function's own output (0149)", () => {
  it("member: struck-through base, the discounted fee with \"with Pro\", and a Pro chip", () => {
    const base = 50; // skilled tier
    const { fee, kind } = bestLeadDiscount(base, new Date(), true);
    expect(kind).toBe("member");
    const feeStr = money(fee);
    const baseStr = money(base);
    expect(feeStr).toBe("$45");

    render(
      <ApplyJobButton
        leadId="lead-1"
        fee={feeStr}
        feeCents={Math.round(fee * 100)}
        canAfford={true}
        baseFee={baseStr}
        discountKind={kind}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: `Apply · ${feeStr}` }));

    expect(bodyHas(baseStr)).toBe(true);
    expect(bodyHas(`${feeStr} with Pro`)).toBe(true);
    expect(bodyHas("Pro")).toBe(true);
    // "Applying charges the $X lead fee" prints the SAME fee string, not a
    // second, independently-derived number.
    expect(bodyHas(`Applying charges the ${feeStr} lead fee`)).toBe(true);
    // Never both discount labels on one card (0149's "never stacked" rule).
    expect(bodyHas("% off, posted")).toBe(false);
  });

  it("aging: struck-through base and the discounted fee, but no Pro chip and no member quiet line", () => {
    const base = 99; // major tier
    const DAY_MS = 86_400_000;
    const createdAt = new Date(Date.now() - 8 * DAY_MS);
    const { fee, off, kind } = bestLeadDiscount(base, createdAt, false);
    expect(kind).toBe("aging");
    expect(off).toBe(30);
    const feeStr = money(fee);
    const baseStr = money(base);
    expect(feeStr).toBe("$69.30");

    render(
      <ApplyJobButton
        leadId="lead-2"
        fee={feeStr}
        feeCents={Math.round(fee * 100)}
        canAfford={true}
        baseFee={baseStr}
        discountKind={kind}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: `Apply · ${feeStr}` }));

    expect(bodyHas(baseStr)).toBe(true);
    expect(bodyHas(`Applying charges the ${feeStr} lead fee`)).toBe(true);
    expect(screen.queryByText("Pro")).not.toBeInTheDocument();
    expect(bodyHas("Pro members pay")).toBe(false);
  });

  it("non-member on a fresh lead: no strike-through, and the honest quiet line links to /pro/plus?reason=leads", () => {
    const base = 25; // light tier
    const nonMember = bestLeadDiscount(base, new Date(), false);
    expect(nonMember.kind).toBeNull();
    const memberWouldPay = bestLeadDiscount(base, new Date(), true);
    expect(memberWouldPay.fee).toBeLessThan(nonMember.fee);
    const feeStr = money(nonMember.fee);
    const memberQuoteStr = money(memberWouldPay.fee);
    expect(memberQuoteStr).toBe(money((base * (100 - PRO_LEAD_DISCOUNT_PCT)) / 100));
    expect(memberQuoteStr).toBe("$22.50");

    render(
      <ApplyJobButton
        leadId="lead-3"
        fee={feeStr}
        feeCents={Math.round(nonMember.fee * 100)}
        canAfford={true}
        baseFee={null}
        discountKind={null}
        memberQuoteStr={memberQuoteStr}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: `Apply · ${feeStr}` }));

    // No strike-through: baseFee was null, so no pre-markdown price renders.
    expect(screen.queryByText(feeStr, { selector: "span.line-through" })).not.toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: `Pro members pay ${memberQuoteStr}`,
    });
    expect(link).toHaveAttribute("href", "/pro/plus?reason=leads");
  });
});
