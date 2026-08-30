// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The real module is a "use server" file that pulls in Stripe and the
// service-role Supabase client. The component only ever passes it to a
// <form action={...}>, so a stub function is enough and keeps the test in the
// UI layer where it belongs.
vi.mock("./actions", () => ({
  startPlusCheckoutAction: vi.fn(),
}));

import PlanToggle from "./PlanToggle";
import { PLUS_PLAN, formatUsd, yearlySavings } from "@/lib/constants";

afterEach(() => {
  cleanup();
});

// There is exactly ONE checkout form now, and its hidden "plan" field is the
// cadence the selected card set. A second form used to sit above it carrying a
// hard-coded weekly field and its own "Start 3 free days" button; it went away
// with the weekly-only trial, and the assertion below is what keeps it away.
function pickerForm(): HTMLFormElement {
  const hidden = document.querySelectorAll<HTMLInputElement>(
    'input[type="hidden"][name="plan"]'
  );
  expect(hidden).toHaveLength(1);
  return hidden[0].closest("form") as HTMLFormElement;
}

function postedPlan(): string {
  return (
    pickerForm().querySelector<HTMLInputElement>('input[name="plan"]')?.value ??
    ""
  );
}

function card(name: RegExp) {
  return screen.getByRole("radio", { name });
}

describe("PlanToggle plan selection", () => {
  it("offers four cards: Weekly, Monthly, Annual, Free", () => {
    render(<PlanToggle />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    for (const name of [/^Weekly/, /^Monthly/, /^Annual/, /^Free/]) {
      expect(card(name)).toBeInTheDocument();
    }
    // Each paid card names its own real price, read from PLUS_PLAN.
    expect(card(/^Weekly/)).toHaveAccessibleName(
      `Weekly, ${formatUsd(PLUS_PLAN.weekly)} a week`
    );
    expect(card(/^Monthly/)).toHaveAccessibleName(
      `Monthly, ${formatUsd(PLUS_PLAN.monthly)} a month`
    );
    expect(card(/^Annual/)).toHaveAccessibleName(
      `Annual, ${formatUsd(PLUS_PLAN.yearly)} a year`
    );
  });

  it("preselects Monthly and posts monthly whether or not the trial is on offer", () => {
    // The free days used to belong to weekly, so an eligible reader landed on
    // the Weekly card. They come with every cadence now, so the page opens on
    // the anchor plan either way - and on the same cadence
    // startPlusCheckoutAction falls back to.
    for (const eligible of [true, false]) {
      render(<PlanToggle trialEligible={eligible} />);
      expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "true");
      expect(card(/^Weekly/)).toHaveAttribute("aria-checked", "false");
      expect(card(/^Annual/)).toHaveAttribute("aria-checked", "false");
      expect(postedPlan()).toBe("monthly");
      cleanup();
    }
  });

  it("labels the one button by the trial, not by the cadence", () => {
    render(<PlanToggle />);
    for (const [name, plan] of [
      [/^Weekly/, "weekly"],
      [/^Annual/, "yearly"],
      [/^Monthly/, "monthly"],
    ] as const) {
      fireEvent.click(card(name));
      expect(postedPlan()).toBe(plan);
      // Same label on every cadence: each one starts the same free days.
      expect(
        within(pickerForm()).getByRole("button", {
          name: `Start ${PLUS_PLAN.trialDays} free days`,
        })
      ).toBeInTheDocument();
    }
  });

  it("promises no free days anywhere when the trial is gone", () => {
    render(<PlanToggle trialEligible={false} />);
    fireEvent.click(card(/^Weekly/));
    // One button, and it says what it does rather than naming free days a
    // returning subscriber will not get.
    expect(
      within(pickerForm()).getByRole("button", { name: "Start Hearth Plus" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: `Start ${PLUS_PLAN.trialDays} free days`,
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(`${PLUS_PLAN.trialDays} days free`))
    ).not.toBeInTheDocument();
  });

  it("shows the free days on all three paid cards, not just weekly", () => {
    render(<PlanToggle />);
    for (const name of [/^Weekly/, /^Monthly/, /^Annual/]) {
      expect(
        within(card(name)).getByText(`${PLUS_PLAN.trialDays} days free`)
      ).toBeInTheDocument();
    }
    // Free is not a checkout, so it promises nothing.
    expect(
      within(card(/^Free/)).queryByText(`${PLUS_PLAN.trialDays} days free`)
    ).not.toBeInTheDocument();
  });

  it("disables the button on Free and never posts a fourth plan value", () => {
    render(<PlanToggle />);
    fireEvent.click(card(/^Free/));

    expect(card(/^Free/)).toHaveAttribute("aria-checked", "true");
    const button = within(pickerForm()).getByRole("button", {
      name: "Keep Free",
    });
    expect(button).toBeDisabled();
    // The hidden field must stay a cadence startPlusCheckoutAction understands
    // (checkoutCadence only resolves weekly, monthly, or yearly).
    expect(["weekly", "monthly", "yearly"]).toContain(postedPlan());
  });

  it("walks the cards with the arrow keys and selects with the keyboard", () => {
    // No trial here so the walk starts from the same Monthly default this
    // test was written against; the trial-on default is covered above.
    render(<PlanToggle trialEligible={false} />);
    const group = screen.getByRole("radiogroup", { name: "Choose your plan" });

    // Monthly -> Annual -> Free -> Weekly, wrapping like a native radio group.
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(card(/^Annual/)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(card(/^Free/)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(card(/^Weekly/)).toHaveAttribute("aria-checked", "true");
    expect(postedPlan()).toBe("weekly");

    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(card(/^Free/)).toHaveAttribute("aria-checked", "true");

    // Roving tabindex: exactly one card is in the tab order at a time.
    const inTabOrder = screen
      .getAllByRole("radio")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(inTabOrder).toHaveLength(1);

    // Space on a card selects it, the way a <button> already does natively.
    fireEvent.click(card(/^Annual/));
    expect(postedPlan()).toBe("yearly");
  });
});

describe("PlanToggle phone description panel", () => {
  // The panel itself is not hidden by any breakpoint class jsdom would
  // respect (see the "offers four cards" comment above on why CSS-only
  // hiding is invisible to these tests) - it queries by aria-live, which is
  // present regardless of viewport, exactly like the panel itself.
  function panel(): HTMLElement {
    return document.querySelector('[aria-live="polite"]') as HTMLElement;
  }

  it("shows the selected plan's name and price, and updates when another card is tapped", () => {
    render(<PlanToggle />);
    // Monthly is the preselected card in every state now.
    expect(
      within(panel()).getByText(
        `Monthly, ${formatUsd(PLUS_PLAN.monthly)} a month`
      )
    ).toBeInTheDocument();

    fireEvent.click(card(/^Weekly/));
    expect(
      within(panel()).getByText(`Weekly, ${formatUsd(PLUS_PLAN.weekly)} a week`)
    ).toBeInTheDocument();
    expect(
      within(panel()).queryByText(
        `Monthly, ${formatUsd(PLUS_PLAN.monthly)} a month`
      )
    ).not.toBeInTheDocument();

    fireEvent.click(card(/^Annual/));
    expect(
      within(panel()).getByText(`Annual, ${formatUsd(PLUS_PLAN.yearly)} a year`)
    ).toBeInTheDocument();
  });

  it("carries the same Plus bullets as the cards", () => {
    render(<PlanToggle trialEligible={false} />);
    expect(
      within(panel()).getByText("Plan and forecast, in full")
    ).toBeInTheDocument();
  });
});

describe("PlanToggle badges", () => {
  it("gives the Annual card a Save badge computed from yearlySavings, not a typed number", () => {
    render(<PlanToggle />);
    expect(
      within(card(/^Annual/)).getByText(
        `Save ${formatUsd(yearlySavings(PLUS_PLAN))}`
      )
    ).toBeInTheDocument();
  });

  it("does not repeat the same claim between the Monthly and Annual badges", () => {
    render(<PlanToggle />);
    // Two spans, one per breakpoint: "Popular" below sm (12px uppercase would
    // wrap in a ~92px phone column at the full length), "Most popular" from sm
    // up. Both are in the DOM; jsdom applies no CSS, so name each exactly.
    expect(
      within(card(/^Monthly/)).getByText("Most popular")
    ).toBeInTheDocument();
    expect(
      within(card(/^Monthly/)).getByText("Popular")
    ).toBeInTheDocument();
    expect(
      within(card(/^Monthly/)).queryByText(/best/i)
    ).not.toBeInTheDocument();
    expect(
      within(card(/^Annual/)).queryByText(/best/i)
    ).not.toBeInTheDocument();
  });

  it("never uses an em dash anywhere on the page", () => {
    render(<PlanToggle />);
    fireEvent.click(card(/^Annual/));
    expect(document.body.textContent).not.toMatch(/—/);
  });
});

describe("PlanToggle checkout disclosure", () => {
  // TWO copies of the disclosure are in the DOM now, one per breakpoint: the
  // phone one lives inside a closed <details> so the checkout button is not
  // pushed off a 390px screen, the desktop one renders open exactly as before.
  // jsdom applies no CSS, so both are "visible" to these queries and every
  // lookup that used to be getByText has to say which copy it means.
  // getAllByText(...) with a length assertion is that: it also pins the count,
  // so a future edit that quietly drops one breakpoint's copy fails here.
  it("keeps the auto-renewal terms inside the checkout form, next to the button", () => {
    // No trial, so the one button says what it does ("Start Hearth Plus")
    // without needing to tap a card first.
    render(<PlanToggle trialEligible={false} />);
    const form = pickerForm();
    const terms = within(form).getAllByText(
      "This subscription renews automatically"
    );
    expect(terms).toHaveLength(2);
    const button = within(form).getByRole("button", {
      name: "Start Hearth Plus",
    });
    expect(button).toBeInTheDocument();
    // The desktop disclosure is still the element immediately before the
    // button's own wrapper (CR3#4's sticky-on-phone bar, a no-op on desktop),
    // so nothing can be slipped between the terms and the act of consent.
    // terms[1] is the second copy in document order, which is the sm-and-up
    // one; the phone copy inside the <details> comes first.
    const desktopBlock = terms[1].closest("div")?.parentElement as HTMLElement;
    const buttonWrapper = desktopBlock.nextElementSibling as HTMLElement;
    expect(buttonWrapper.contains(button)).toBe(true);
  });

  it("collapses the phone disclosure by default but keeps the full terms in it", () => {
    render(<PlanToggle trialEligible={false} />);
    const form = pickerForm();
    // One <details> per checkout form, closed on first paint. Closed and not
    // absent: the terms are one tap away, not gone.
    const details = form.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(within(details).getByText("Billing terms")).toBeInTheDocument();
    // The itemized block really is inside it, not a summary of it.
    expect(
      within(details).getByText("This subscription renews automatically")
    ).toBeInTheDocument();
    expect(within(details).getByText("Then:")).toBeInTheDocument();
    expect(within(details).getByText("To cancel:")).toBeInTheDocument();
  });

  it("keeps the one-line material terms visible on a phone without opening anything", () => {
    render(<PlanToggle trialEligible={false} />);
    const form = pickerForm();
    // Outside the <details>: the sentence that carries price, cadence and how
    // to stop it is never behind a tap.
    // The same sentence also appears in the phone description panel above the
    // picker, so this checks every copy rather than assuming there is one.
    const summaryLines = within(form).getAllByText(
      `${formatUsd(PLUS_PLAN.monthly)} a month, cancel anytime.`
    );
    expect(summaryLines.length).toBeGreaterThan(0);
    for (const line of summaryLines) {
      expect(line.closest("details")).toBeNull();
    }
  });
  it("restates the terms for the plan actually selected, without a trial", () => {
    render(<PlanToggle trialEligible={false} />);
    // A returning subscriber is charged on day one on every cadence, so no
    // copy here may promise free days.
    expect(
      within(pickerForm()).getAllByText(
        new RegExp(
          `\\${formatUsd(PLUS_PLAN.monthly)} today, and it renews every month`
        )
      )
    ).toHaveLength(2);

    fireEvent.click(card(/^Annual/));
    expect(
      within(pickerForm()).getAllByText(/renews every 12 months/)
    ).toHaveLength(2);

    fireEvent.click(card(/^Weekly/));
    expect(
      within(pickerForm()).queryByText(
        new RegExp(`Free for ${PLUS_PLAN.trialDays} days`)
      )
    ).not.toBeInTheDocument();
  });

  it("carries the free days into the terms of whichever cadence is selected", () => {
    render(<PlanToggle />);
    // Two copies of the itemized block per cadence, phone and desktop, and the
    // step-up sentence names the price the trial ends into. Annual is the case
    // the old weekly-only rule could not express at all.
    for (const [name, price, renews] of [
      [/^Annual/, formatUsd(PLUS_PLAN.yearly), "every 12 months"],
      [/^Monthly/, `${formatUsd(PLUS_PLAN.monthly)} a month`, "every month"],
      [/^Weekly/, `${formatUsd(PLUS_PLAN.weekly)} a week`, "every week"],
    ] as const) {
      fireEvent.click(card(name));
      const stepUp = within(pickerForm()).getAllByText(
        new RegExp(
          `Free for ${PLUS_PLAN.trialDays} days\\. After that it is \\${price}, and it renews ${renews} until you cancel\\.`
        )
      );
      expect(stepUp).toHaveLength(2);
    }
  });

  it("states the one-line material terms per cadence, beside the button", () => {
    // The exact sentence the owner asked for, per card, never behind a tap:
    // free days, the price they step up to, and how to stop it.
    render(<PlanToggle />);
    for (const [name, expected] of [
      [
        /^Weekly/,
        `${PLUS_PLAN.trialDays} days free, then ${formatUsd(PLUS_PLAN.weekly)}/week. Cancel anytime before the trial ends.`,
      ],
      [
        /^Monthly/,
        `${PLUS_PLAN.trialDays} days free, then ${formatUsd(PLUS_PLAN.monthly)}/month. Cancel anytime before the trial ends.`,
      ],
      [
        /^Annual/,
        `${PLUS_PLAN.trialDays} days free, then ${formatUsd(PLUS_PLAN.yearly)}/year. Cancel anytime before the trial ends.`,
      ],
    ] as const) {
      fireEvent.click(card(name));
      const lines = screen.getAllByText(expected);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.closest("details")).toBeNull();
      }
    }
  });
});

// CR3#4 and CR3#9: the phone-only sticky checkout bar, and the mobile price
// blocks no longer reserving height for a bullet list that is hidden below
// sm. jsdom applies no CSS, so these assert the classes rather than actual
// layout - reading them is the verification, per the hard rules.
describe("PlanToggle phone checkout bar", () => {
  it("wraps the submit button in a sticky bottom bar, phone only", () => {
    render(<PlanToggle trialEligible={false} />);
    const button = within(pickerForm()).getByRole("button", {
      name: "Start Hearth Plus",
    });
    const wrapper = button.parentElement as HTMLElement;
    expect(wrapper.className).toContain("max-sm:sticky");
    expect(wrapper.className).toContain("max-sm:bottom-");
    // No sm: sticky/positioning class, so desktop keeps its normal
    // in-flow button.
    expect(wrapper.className).not.toMatch(/(?<!max-)sm:sticky/);
  });

  it("keeps the sticky bar for the disabled Free-plan button too", () => {
    render(<PlanToggle trialEligible={false} />);
    fireEvent.click(card(/^Free/));
    const button = screen.getByRole("button", { name: "Keep Free" });
    expect(button).toBeDisabled();
    const wrapper = button.parentElement as HTMLElement;
    expect(wrapper.className).toContain("max-sm:sticky");
  });

  it("drops the phone min-h floor on the three paid price blocks", () => {
    const { container } = render(<PlanToggle trialEligible={false} />);
    const priceBlocks = Array.from(
      container.querySelectorAll("span.mt-0\\.5.block")
    ).filter((el) => el.className.includes("sm:min-h-11"));
    // Weekly, Monthly, Annual, Free: one such block per card.
    expect(priceBlocks).toHaveLength(4);
    // The Free card's own block (inside its max-sm:hidden button) keeps its
    // min-h on purpose - it never renders on a phone at all, so there is no
    // dead space to remove there. Identified by its "$0" price, since Free
    // is the one card with no bulletList-matching min-h to drop.
    const freeBlock = priceBlocks.find((el) => el.textContent?.includes("$0"));
    const paidBlocks = priceBlocks.filter((el) => el !== freeBlock);
    expect(freeBlock).toBeTruthy();
    expect(paidBlocks).toHaveLength(3);
    expect(freeBlock!.className).toContain("min-h-10");
    for (const el of paidBlocks) {
      expect(el.className).not.toContain("min-h-10");
    }
  });
});
