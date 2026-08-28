// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Both action modules pull in the service-role Supabase client transitively
// (createAdminClient -> "server-only"), which throws the moment it's
// imported under jsdom. Mocked out exactly like ReviewPrompt.test.tsx mocks
// its own "use server" actions, so the real component renders in the UI
// layer with no server dependency.
// Never resolves during the test, matching src/components/SubmitButton.test.tsx's
// own double-click test: a REAL server action is async and stays pending for
// at least one network round trip, so `pending` from useFormStatus does not
// flip back to false (and reset the latch) between the two synchronous
// clicks below. A plain vi.fn() returning undefined would settle instantly
// and defeat the very race this test exists to catch.
const saveCompanyAction = vi.fn((..._args: unknown[]) => new Promise(() => {}));
const verifyLicenseNowAction = vi.fn();
vi.mock("../actions", () => ({
  saveCompanyAction: (...args: unknown[]) => saveCompanyAction(...args),
  verifyLicenseNowAction: (...args: unknown[]) => verifyLicenseNowAction(...args),
}));
const licenseDisputeAction = vi.fn();
vi.mock("./actions", () => ({
  licenseDisputeAction: (...args: unknown[]) => licenseDisputeAction(...args),
}));

import PublicProfileForm from "./PublicProfileForm";

afterEach(() => {
  cleanup();
  saveCompanyAction.mockClear();
});

// A minimal contractor row: only the fields PublicProfileForm actually reads.
// `any`, not the generated Contractor type, since several of these fields
// (service_state, and the whole license_verify_detail shape) are cast with
// `as any` inside the component itself for the same not-yet-regenerated-types
// reason documented there.
const CONTRACTOR: any = {
  id: "c1",
  name: "Acme Plumbing",
  contact_email: "acme@example.com",
  contact_phone: "",
  categories: ["plumbing"],
  license_number: null,
  license_verified_status: null,
  license_verified_at: null,
  license_verify_detail: null,
  launch_cities: [],
  service_state: null,
  yelp_url: null,
  google_reviews_url: null,
};

describe("PublicProfileForm's Save Changes button: double-submit latch", () => {
  it("submits once when clicked twice in rapid succession", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    const button = screen.getByRole("button", { name: /save changes/i });
    // Two clicks back to back, before React gets a chance to re-render with
    // useFormStatus's pending flipped to true - the exact race that let a
    // fast double tap fire two saves (confirmed live on this button).
    fireEvent.click(button);
    fireEvent.click(button);
    expect(saveCompanyAction).toHaveBeenCalledTimes(1);
  });

  it("still submits normally on a single click", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(saveCompanyAction).toHaveBeenCalledTimes(1);
  });
});

describe("PublicProfileForm stays mounted across a save", () => {
  // Regression test for the bug where the whole form disappeared after every
  // Save Changes tap until a manual reload (root cause: the server action
  // redirected back to the exact same path it was submitted from, a Next.js
  // App Router footgun that could leave the route stuck on its loading
  // boundary - see the fix in src/app/pro/actions.ts's saveCompanyAction).
  // This can't reproduce that server-side routing bug directly under jsdom
  // (there's no real Next.js router here), but it does prove the client tree
  // itself never unmounts the form merely because a save is submitted and
  // pending - the form, its fields, and their values must all still be
  // present and untouched.
  it("keeps the form and its field values on screen while a save is pending", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(saveCompanyAction).toHaveBeenCalledTimes(1);

    // The pending action never resolves (see the mock above), matching how a
    // real server action stays in flight for at least one round trip - if
    // anything were unmounting the form on submit, none of this would still
    // be here to find.
    expect(screen.getByDisplayValue(CONTRACTOR.name)).toBeInTheDocument();
    expect(screen.getByDisplayValue(CONTRACTOR.contact_email)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save changes/i })
    ).toBeInTheDocument();
  });
});

describe("PublicProfileForm phone tap targets", () => {
  // "Change Cover" is a small pill floating on the cover banner, sized for a
  // mouse (px-3 py-1.5 lands around 34px). The phone-only bump is what brings
  // it to the 44px thumb minimum. jsdom applies no CSS, so the class is what
  // there is to assert; the bump is max-sm:, so desktop is unchanged.
  it("gives the Change Cover pill a 44px minimum on a phone", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    expect(
      screen.getByRole("button", { name: /change cover/i }).className
    ).toContain("max-sm:min-h-11");
  });
});
