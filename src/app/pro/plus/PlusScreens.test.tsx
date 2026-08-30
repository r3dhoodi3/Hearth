// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// PlusScreens.tsx imports ProPlanToggle (used only by its PlusPitch branch,
// which these tests never render), and ProPlanToggle pulls in ./actions.ts,
// which pulls in @/lib/stripe - a "server-only" module that throws the
// moment it is imported outside a real server render. Stubbed the same way
// src/app/pro/profile/PublicProfileForm.test.tsx stubs its own "use server"
// action imports, so PlusMember and PlusPastDue render with no server
// dependency.
vi.mock("./ProPlanToggle", () => ({ default: () => null }));
vi.mock("./actions", () => ({}));

import { PlusMember, PlusPastDue } from "./PlusScreens";

afterEach(cleanup);

// MED-45: "Manage billing", "Keep my membership", and "Update payment
// method" were plain <button>s with no useFormStatus pending state and no
// double-submit guard - a fast double tap could open two Stripe billing
// portal sessions, or fire two resume-membership writes. All three now go
// through SubmitButton (src/components/SubmitButton.tsx), whose
// submittedRef latch these tests exercise the same way
// src/app/pro/profile/PublicProfileForm.test.tsx does for Save Changes.
//
// Actions never resolve during the test, matching SubmitButton.test.tsx's
// own double-click test: a real server action stays pending for at least
// one round trip, so `pending` does not flip back to false (and reset the
// latch) between the two synchronous clicks below.
function neverResolving() {
  return vi.fn(() => new Promise<void>(() => {}));
}

describe("PlusMember: Manage billing double-submit", () => {
  it("submits once when clicked twice in rapid succession", () => {
    const manageAction = neverResolving();
    render(
      <PlusMember
        planLabel="Monthly"
        periodSuffix=""
        cancelsAtLabel={null}
        cancelNote={null}
        trialing={false}
        manageAction={manageAction}
        resumeAction={vi.fn()}
        cancelAction={vi.fn()}
      />
    );
    const button = screen.getByRole("button", { name: /manage billing/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(manageAction).toHaveBeenCalledTimes(1);
  });
});

describe("PlusMember: Keep my membership double-submit", () => {
  it("submits once when clicked twice in rapid succession", () => {
    const resumeAction = neverResolving();
    render(
      <PlusMember
        planLabel="Monthly"
        periodSuffix=""
        // Renders the "Keep my membership" form: cancelsAtLabel must be set.
        cancelsAtLabel="January 2, 2027"
        cancelNote={null}
        trialing={false}
        manageAction={vi.fn()}
        resumeAction={resumeAction}
        cancelAction={vi.fn()}
      />
    );
    const button = screen.getByRole("button", { name: /keep my membership/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(resumeAction).toHaveBeenCalledTimes(1);
  });
});

describe("PlusPastDue: Update payment method double-submit", () => {
  it("submits once when clicked twice in rapid succession", () => {
    const manageAction = neverResolving();
    render(
      <PlusPastDue manageAction={manageAction} cancelAction={vi.fn()} />
    );
    const button = screen.getByRole("button", {
      name: /update payment method/i,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(manageAction).toHaveBeenCalledTimes(1);
  });
});
