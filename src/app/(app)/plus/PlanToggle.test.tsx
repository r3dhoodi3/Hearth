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
// component has its own form with a hard-coded monthly field.
function pickerForm(): HTMLFormElement {
  const hidden = document.querySelectorAll<HTMLInputElement>(
    'input[type="hidden"][name="plan"]'
  );
  // Two forms: [0] is the top trial button (always monthly), [1] is the
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
  it("preselects Annual and posts yearly", () => {
    render(<PlanToggle />);
    expect(card(/^Annual/)).toHaveAttribute("aria-checked", "true");
    expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "false");
    expect(postedPlan()).toBe("yearly");
    expect(
      within(pickerForm()).getByRole("button", { name: "Get Annual" })
    ).toBeInTheDocument();
  });

  it("moves the selection and the posted plan when a card is tapped", () => {
    render(<PlanToggle />);
    fireEvent.click(card(/^Monthly/));

    expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "true");
    expect(card(/^Annual/)).toHaveAttribute("aria-checked", "false");
    expect(postedPlan()).toBe("monthly");
    expect(
      within(pickerForm()).getByRole("button", {
        name: `Start ${PLUS_PLAN.trialDays} days free`,
      })
    ).toBeInTheDocument();
  });

  it("labels the monthly button without trial copy when the trial is gone", () => {
    render(<PlanToggle trialEligible={false} />);
    fireEvent.click(card(/^Monthly/));
    expect(
      within(pickerForm()).getByRole("button", { name: "Start monthly" })
    ).toBeInTheDocument();
    // No trial means no top trial button either: only the picker's form is
    // left, and it must not promise free days.
    expect(
      screen.queryByRole("button", {
        name: `Start ${PLUS_PLAN.trialDays} free days`,
      })
    ).not.toBeInTheDocument();
  });

  it("disables the button on Free and never posts a third plan value", () => {
    render(<PlanToggle />);
    fireEvent.click(card(/^Free/));

    expect(card(/^Free/)).toHaveAttribute("aria-checked", "true");
    const button = within(pickerForm()).getByRole("button", {
      name: "Keep Free",
    });
    expect(button).toBeDisabled();
    // The hidden field must stay a cadence startPlusCheckoutAction understands
    // (checkoutCadence only resolves "monthly" or "yearly").
    expect(["monthly", "yearly"]).toContain(postedPlan());
  });

  it("walks the cards with the arrow keys and selects with the keyboard", () => {
    render(<PlanToggle />);
    const group = screen.getByRole("radiogroup", { name: "Choose your plan" });

    // Annual -> Free -> Monthly, wrapping like a native radio group.
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(card(/^Free/)).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(card(/^Monthly/)).toHaveAttribute("aria-checked", "true");
    expect(postedPlan()).toBe("monthly");

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
    const button = within(form).getByRole("button", { name: "Get Annual" });
    expect(terms).toBeInTheDocument();
    expect(button).toBeInTheDocument();
    // The disclosure block is the element immediately before the button, so
    // nothing can be slipped between the terms and the act of consent.
    const termsBlock = terms.closest("div") as HTMLElement;
    expect(termsBlock.nextElementSibling).toBe(button);
  });

  it("restates the terms for the plan actually selected", () => {
    render(<PlanToggle />);
    const form = pickerForm();
    // Annual bills on day one: no free-days promise anywhere in its terms.
    expect(within(form).getByText(/renews every 12 months/)).toBeInTheDocument();

    fireEvent.click(card(/^Monthly/));
    expect(
      within(pickerForm()).getByText(
        new RegExp(`Free for ${PLUS_PLAN.trialDays} days`)
      )
    ).toBeInTheDocument();
  });

  it("carries its own monthly terms next to the top trial button", () => {
    render(<PlanToggle />);
    const trialButton = screen.getByRole("button", {
      name: `Start ${PLUS_PLAN.trialDays} free days`,
    });
    const form = trialButton.closest("form") as HTMLFormElement;
    // The trial belongs to monthly only, so the button that starts it posts
    // monthly and the terms beside it are monthly's.
    expect(
      form.querySelector<HTMLInputElement>('input[name="plan"]')?.value
    ).toBe("monthly");
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
            PLUS_PLAN.monthly
          )}/month`
        )
      )
    ).toBeInTheDocument();
  });
});
