// @vitest-environment jsdom
//
// The pro signup wizard's two failure modes testers hit on a phone, both of
// them about the draft in localStorage rather than about any field:
//
//   1. A trade chip that cleared itself after the pro used the city list, so
//      Next said "Pick at least one type of work" about a chip they had
//      watched light up. The chips live in CategoryPicker's own state, seeded
//      once from a prop, and the wizard REMOUNTS that component whenever it
//      restores a draft - so a restore that lands a beat after the pro's first
//      tap throws the tap away.
//   2. A draft that did not survive a sign-out and sign-in on the same
//      account, because a render with no user id behind it wrote to a key
//      every account on the browser shared.
//
// Everything here drives the real component through real events; the only
// stand-ins are the server action it posts to and the router hook it reads
// ?waitlisted= from.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({ saveCompanyAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

import OnboardingCompanyForm from "./OnboardingCompanyForm";
import { proOnboardingDraftKey } from "./draftKey";
import { LAUNCH_CITIES } from "./launchCities";

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
});

// Draft saves are deferred by a tick on purpose (a React event handler runs
// before the re-render it caused), so a test that reads storage has to let
// that tick happen.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderWizard(userId = "user-1") {
  const utils = render(
    <OnboardingCompanyForm userId={userId} defaultEmail="pro@example.com" />
  );
  return { ...utils, form: document.querySelector("form") as HTMLFormElement };
}

function storedDraft(userId: string) {
  const key = proOnboardingDraftKey(userId);
  const raw = key ? window.localStorage.getItem(key) : null;
  return raw ? JSON.parse(raw) : null;
}

function fillStepOne() {
  fireEvent.change(screen.getByLabelText(/Company name/), {
    target: { value: "Acme Plumbing" },
  });
  fireEvent.change(screen.getByLabelText("Phone number"), {
    target: { value: "7145551234" },
  });
}

function next() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

function pickSpecificCities() {
  fireEvent.click(
    screen.getByRole("button", { name: "Pick specific cities instead" })
  );
}

describe("pro onboarding wizard: the trade chips", () => {
  it("keeps the picked trade through the whole city-list detour", async () => {
    const { form } = renderWizard();
    fillStepOne();
    next();

    fireEvent.click(screen.getByRole("button", { name: "Plumbing" }));
    expect(screen.getByRole("button", { name: "Plumbing" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // The exact sequence from the report: open the disclosure, check a couple
    // of cities, then Next.
    pickSpecificCities();
    fireEvent.click(screen.getByLabelText("Irvine"));
    fireEvent.click(screen.getByLabelText("Tustin"));

    expect(screen.getByRole("button", { name: "Plumbing" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(new FormData(form).getAll("categories")).toEqual(["plumbing"]);

    next();
    expect(screen.queryByRole("alert")).toBeNull();
    await settle();
  });

  it("never lets a late draft restore clear a trade the pro already picked", async () => {
    // The race behind the report. The wizard restores its draft from an
    // effect, and that restore remounts the pickers - so if it runs after the
    // pro's first tap (a Suspense boundary hydrates on its own schedule, and
    // this one is hydrated by the very tap being replayed into it), the tap is
    // thrown away and the chip goes dark. Modelled here the only way a test
    // can: a form that starts with no account id (so no restore is possible)
    // and is handed one afterwards, which re-runs exactly that effect.
    window.localStorage.setItem(
      proOnboardingDraftKey("user-1") as string,
      JSON.stringify({
        savedAt: Date.now(),
        v: 2,
        step: 1,
        name: "Stale Draft Co",
        phone: "",
        license: "",
        referral: "",
        cities: [],
        categories: [],
      })
    );

    const { rerender, form } = renderWizard("");
    fillStepOne();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Plumbing" }));
    pickSpecificCities();
    fireEvent.click(screen.getByLabelText("Irvine"));

    rerender(
      <OnboardingCompanyForm userId="user-1" defaultEmail="pro@example.com" />
    );
    await settle();

    expect(screen.getByRole("button", { name: "Plumbing" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(new FormData(form).getAll("categories")).toEqual(["plumbing"]);
    // And it did not quietly swap the company name out from under them either.
    expect(screen.getByLabelText(/Company name/)).toHaveValue("Acme Plumbing");
  });
});

describe("pro onboarding wizard: a failed save at the last step", () => {
  // The tester's exact report: a CSLB/contractors save that failed left the
  // red error banner on screen with the wizard itself gone entirely (no
  // form, no Back button), and a reload was the only way to get it back. The
  // actual bug was a server action redirecting to the same route it was
  // already on (see ../actions.ts's saveCompanyAction and its test), which
  // this component-level test cannot reproduce directly - that is a Next.js
  // App Router remount, not anything this component's own state does. What
  // this pins down instead is the half that WAS working and has to keep
  // working now that the real fix removes the redirect: the draft this form
  // keeps saving underneath (see the DRAFT LIFETIME comment above) restores
  // the pro straight back to the last step, fields and Back/Finish buttons
  // included, rather than a blank step 1 - i.e. the "reload restored the
  // wizard at step 3" the tester already relied on to recover.
  it("restores at the last step, fields and buttons intact, after the wizard remounts", async () => {
    renderWizard("user-1");
    fillStepOne();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Plumbing" }));
    pickSpecificCities();
    fireEvent.click(screen.getByLabelText("Irvine"));
    next();
    await settle();
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();

    // Simulate the remount a reload (or the redirect the fix removes) causes.
    cleanup();
    renderWizard("user-1");
    await settle();

    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Almost done" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Company name/)).toHaveValue("Acme Plumbing");
    expect(screen.getByLabelText("State license number")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Back to step/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Finish setup" })
    ).toBeInTheDocument();
  });
});

describe("pro onboarding wizard: the draft", () => {
  it("comes back for the same account after a sign-out and sign-in", async () => {
    renderWizard("user-1");
    fillStepOne();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Plumbing" }));
    await settle();

    // Sign out, sign back in: the page is torn down and built again, and
    // nothing in the sign-out path touches localStorage.
    cleanup();
    renderWizard("user-1");
    await settle();

    expect(screen.getByLabelText(/Company name/)).toHaveValue("Acme Plumbing");
    expect(screen.getByLabelText("Phone number")).toHaveValue(
      "(714) 555-1234"
    );
    expect(screen.getByRole("button", { name: "Plumbing" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("never shows one account's answers to another on the same browser", async () => {
    renderWizard("user-1");
    fillStepOne();
    await settle();
    cleanup();

    renderWizard("user-2");
    await settle();
    expect(screen.getByLabelText(/Company name/)).toHaveValue("");
    expect(storedDraft("user-1").name).toBe("Acme Plumbing");
  });

  it("writes nothing at all when the page could not read an account", async () => {
    // The old unscoped fallback key: a render with no user id wrote here, and
    // the next account to open the wizard read a stranger's licence number
    // back out of it. Now such a render simply keeps no draft.
    renderWizard("");
    fillStepOne();
    await settle();
    expect(window.localStorage.length).toBe(0);
  });

  it("saves the narrowed cities, not the 36 the form was posting a moment ago", async () => {
    // "All of Orange County" posts a hidden input per launch city, and
    // unchecking it removes all 36 on the NEXT render. The draft is written
    // from the live form, so this pins down that it always mirrors the answer
    // the pro can see rather than the one the form was posting a beat ago.
    renderWizard("user-1");
    fillStepOne();
    next();
    fireEvent.click(screen.getByLabelText("All of Orange County"));
    await settle();
    expect(storedDraft("user-1").cities).toEqual([]);

    fireEvent.click(screen.getByLabelText("Irvine"));
    await settle();
    expect(storedDraft("user-1").cities).toEqual(["Irvine"]);

    // And back to the whole county writes all of them again.
    fireEvent.click(screen.getByLabelText("All of Orange County"));
    await settle();
    expect(storedDraft("user-1").cities).toEqual([...LAUNCH_CITIES]);
  });
});
