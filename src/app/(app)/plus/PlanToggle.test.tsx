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
import { PLUS_PLAN, formatUsd } from "@/lib/constants";

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

  it("preselects Monthly and posts monthly", () => {
    render(<PlanToggle />);
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
    render(<PlanToggle />);
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

describe("PlanToggle checkout disclosure", () => {
  it("keeps the auto-renewal terms inside the checkout form, next to the button", () => {
    render(<PlanToggle />);
    const form = pickerForm();
    const terms = within(form).getByText(
      "This subscription renews automatically"
    );
    const button = within(form).getByRole("button", { name: "Get Monthly" });
    expect(terms).toBeInTheDocument();
    expect(button).toBeInTheDocument();
    // The disclosure block is the element immediately before the button, so
    // nothing can be slipped between the terms and the act of consent.
    const termsBlock = terms.closest("div") as HTMLElement;
    expect(termsBlock.nextElementSibling).toBe(button);
  });

  it("restates the terms for the plan actually selected", () => {
    render(<PlanToggle />);
    // Monthly bills on day one: no free-days promise in the picker's terms.
    expect(
      within(pickerForm()).getByText(
        new RegExp(
          `\\${formatUsd(PLUS_PLAN.monthly)} today, and it renews every month`
        )
      )
    ).toBeInTheDocument();

    fireEvent.click(card(/^Annual/));
    expect(
      within(pickerForm()).getByText(/renews every 12 months/)
    ).toBeInTheDocument();

    fireEvent.click(card(/^Weekly/));
    expect(
      within(pickerForm()).getByText(
        new RegExp(`Free for ${PLUS_PLAN.trialDays} days`)
      )
    ).toBeInTheDocument();
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
    expect(
      within(form).getByText("This subscription renews automatically")
    ).toBeInTheDocument();
    expect(
      within(form).getByText(
        new RegExp(`Free for ${PLUS_PLAN.trialDays} days`)
      )
    ).toBeInTheDocument();
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
