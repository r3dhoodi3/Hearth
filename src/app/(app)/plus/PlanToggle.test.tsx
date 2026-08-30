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

// The form that carries the plan picker is the one with the hidden "plan"
// field the reader can actually change. The trial button at the top of the
// component has its own form with a hard-coded weekly field.
function pickerForm(): HTMLFormElement {
  const hidden = document.querySelectorAll<HTMLInputElement>(
    'input[type="hidden"][name="plan"]'
  );
  // Two forms: [0] is the top trial button (always weekly), [1] is the
  // picker. When the trial is not offered, the picker is the only one.
  const picker = hidden[hidden.length - 1];
  return picker.closest("form") as HTMLFormElement;
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

  it("preselects Weekly and posts weekly when the trial is on offer, agreeing with the top trial button", () => {
    render(<PlanToggle />);
    expect(card(/^Weekly/)).toHaveAttribute("aria-checked", "true");
    expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "false");
    expect(card(/^Annual/)).toHaveAttribute("aria-checked", "false");
    expect(postedPlan()).toBe("weekly");
    expect(
      within(pickerForm()).getByRole("button", {
        name: `Start ${PLUS_PLAN.trialDays} days free`,
      })
    ).toBeInTheDocument();
  });

  it("preselects Monthly and posts monthly when there is no trial to offer", () => {
    render(<PlanToggle trialEligible={false} />);
    expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "true");
    expect(card(/^Weekly/)).toHaveAttribute("aria-checked", "false");
    expect(card(/^Annual/)).toHaveAttribute("aria-checked", "false");
    expect(postedPlan()).toBe("monthly");
    expect(
      within(pickerForm()).getByRole("button", { name: "Get Monthly" })
    ).toBeInTheDocument();
  });

  it("moves the selection and the posted plan when a card is tapped", () => {
    render(<PlanToggle />);

    fireEvent.click(card(/^Weekly/));
    expect(card(/^Weekly/)).toHaveAttribute("aria-checked", "true");
    expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "false");
    expect(postedPlan()).toBe("weekly");
    expect(
      within(pickerForm()).getByRole("button", {
        name: `Start ${PLUS_PLAN.trialDays} days free`,
      })
    ).toBeInTheDocument();

    fireEvent.click(card(/^Annual/));
    expect(postedPlan()).toBe("yearly");
    expect(
      within(pickerForm()).getByRole("button", { name: "Get Annual" })
    ).toBeInTheDocument();
  });

  it("labels the weekly button without trial copy when the trial is gone", () => {
    render(<PlanToggle trialEligible={false} />);
    fireEvent.click(card(/^Weekly/));
    expect(
      within(pickerForm()).getByRole("button", { name: "Start weekly" })
    ).toBeInTheDocument();
    // No trial means no top trial button either, and nothing anywhere may
    // promise free days.
    expect(
      screen.queryByRole("button", {
        name: `Start ${PLUS_PLAN.trialDays} free days`,
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(`${PLUS_PLAN.trialDays} days free`))
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
    expect(
      within(panel()).getByText(`Weekly, ${formatUsd(PLUS_PLAN.weekly)} a week`)
    ).toBeInTheDocument();

    fireEvent.click(card(/^Monthly/));
    expect(
      within(panel()).getByText(
        `Monthly, ${formatUsd(PLUS_PLAN.monthly)} a month`
      )
    ).toBeInTheDocument();
    expect(
      within(panel()).queryByText(
        `Weekly, ${formatUsd(PLUS_PLAN.weekly)} a week`
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
    // No trial, so the picker defaults to Monthly and "Get Monthly" is on
    // screen without needing to tap a card first.
    render(<PlanToggle trialEligible={false} />);
    const form = pickerForm();
    const terms = within(form).getAllByText(
      "This subscription renews automatically"
    );
    expect(terms).toHaveLength(2);
    const button = within(form).getByRole("button", { name: "Get Monthly" });
    expect(button).toBeInTheDocument();
    // The desktop disclosure is still the element immediately before the
    // button, so nothing can be slipped between the terms and the act of
    // consent. terms[1] is the second copy in document order, which is the
    // sm-and-up one; the phone copy inside the <details> comes first.
    const desktopBlock = terms[1].closest("div")?.parentElement as HTMLElement;
    expect(desktopBlock.nextElementSibling).toBe(button);
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
  it("restates the terms for the plan actually selected", () => {
    render(<PlanToggle />);
    // The trial default is Weekly (see above); select Monthly explicitly to
    // check its terms first.
    fireEvent.click(card(/^Monthly/));
    // Monthly bills on day one: no free-days promise in the picker's terms.
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
      within(pickerForm()).getAllByText(
        new RegExp(`Free for ${PLUS_PLAN.trialDays} days`)
      )
    ).toHaveLength(2);
  });

  it("carries its own weekly terms next to the top trial button", () => {
    render(<PlanToggle />);
    const trialButton = screen.getByRole("button", {
      name: `Start ${PLUS_PLAN.trialDays} free days`,
    });
    const form = trialButton.closest("form") as HTMLFormElement;
    // The trial belongs to weekly only, so the button that starts it posts
    // weekly and the terms beside it are weekly's.
    expect(
      form.querySelector<HTMLInputElement>('input[name="plan"]')?.value
    ).toBe("weekly");
    // Two copies here too: phone (inside a closed <details>) and desktop.
    expect(
      within(form).getAllByText("This subscription renews automatically")
    ).toHaveLength(2);
    expect(
      within(form).getAllByText(
        new RegExp(`Free for ${PLUS_PLAN.trialDays} days`)
      )
    ).toHaveLength(2);
    expect((form.querySelector("details") as HTMLDetailsElement).open).toBe(
      false
    );
    // The one line under the button quotes the real price, never a typed one.
    expect(
      within(form).getByText(
        new RegExp(
          `${PLUS_PLAN.trialDays} days free, then \\${formatUsd(
            PLUS_PLAN.weekly
          )}/week`
        )
      )
    ).toBeInTheDocument();
  });
});
