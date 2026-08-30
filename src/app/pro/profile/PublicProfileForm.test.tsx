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
  // HIGH-19: PhoneInput is now required+pattern on this form, so a fixture
  // an existing contractor row normally has a real number - most tests below
  // exercise unrelated behavior and should not be blocked by an incidentally
  // blank phone. The phone-specific behavior gets its own describe block.
  contact_phone: "(714) 555-0100",
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

// HIGH-19: contact_phone had no client-side validation on this form at all
// (no required, no pattern), so an empty or malformed number could be saved
// silently - the exact number "Homeowners call this number after they pick
// you" promises would go nowhere. Mirrors src/components/SubmitButton.test.tsx's
// own "browser blocks an invalid submit" pattern: jsdom does not show the
// browser's validation bubble, but it does refuse to dispatch the form's
// submit event (and so the action prop never runs) while a required/pattern
// control is invalid.
describe("PublicProfileForm phone validation", () => {
  function phoneField(container: HTMLElement): HTMLInputElement {
    return container.querySelector(
      'input[name="contact_phone"]'
    ) as HTMLInputElement;
  }

  it("blocks the save when the phone number is blank", () => {
    const { container } = render(
      <PublicProfileForm contractor={{ ...CONTRACTOR, contact_phone: "" }} />
    );
    expect(phoneField(container).checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(saveCompanyAction).not.toHaveBeenCalled();
  });

  it("blocks the save when the phone number has fewer than ten digits", () => {
    const { container } = render(
      <PublicProfileForm
        contractor={{ ...CONTRACTOR, contact_phone: "714555" }}
      />
    );
    expect(phoneField(container).checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(saveCompanyAction).not.toHaveBeenCalled();
  });

  it("allows the save once a full ten-digit number is entered", () => {
    const { container } = render(
      <PublicProfileForm contractor={{ ...CONTRACTOR, contact_phone: "" }} />
    );
    const input = phoneField(container);
    fireEvent.change(input, { target: { value: "7145550100" } });
    expect(input.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(saveCompanyAction).toHaveBeenCalledTimes(1);
  });
});

// MED-20: "Change Cover" and the avatar "+" were both buttons with no
// handler and nothing behind them - no cover feature anywhere in the app,
// and the real logo upload already lives on the Pro-gated "Your Public
// Page" tab (LogoUpload.tsx via PublicPageCard.tsx). Removed rather than
// wired up; these tests pin that removal instead of the old dead controls.
describe("PublicProfileForm has no dead cover/logo buttons", () => {
  it("renders no 'Change Cover' control", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    expect(
      screen.queryByRole("button", { name: /change cover/i })
    ).not.toBeInTheDocument();
  });

  it("renders no clickable '+' avatar control, and points to the real place to add a logo", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    expect(screen.queryByText("+")).not.toBeInTheDocument();
    expect(
      screen.getByText(/add a logo from the "your public page" tab/i)
    ).toBeInTheDocument();
  });
});

// CEO pass D3: the license status badges carry meaning (verified / not
// confirmed / pending), so on a phone they step up to 14px instead of the
// old 12px. Desktop (base text-[10px], no max-sm prefix reaches it) is
// unchanged.
describe("PublicProfileForm license status badges on a phone", () => {
  it("License verified: 14px on a phone, 10px above sm", () => {
    render(
      <PublicProfileForm
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "verified",
        }}
      />
    );
    const badge = screen.getByText("License verified").closest("span");
    expect(badge?.className).toContain("text-[10px]");
    expect(badge?.className).toContain("max-sm:text-sm");
    expect(badge?.className).not.toContain("max-sm:text-xs");
  });

  it("Not confirmed: 14px on a phone, 10px above sm", () => {
    render(
      <PublicProfileForm
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "failed",
        }}
      />
    );
    const badge = screen.getByText("Not confirmed");
    expect(badge.className).toContain("text-[10px]");
    expect(badge.className).toContain("max-sm:text-sm");
  });

  it("Verification pending: 14px on a phone, 10px above sm", () => {
    render(
      <PublicProfileForm
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "pending",
        }}
      />
    );
    const badge = screen.getByText("Verification pending");
    expect(badge.className).toContain("text-[10px]");
    expect(badge.className).toContain("max-sm:text-sm");
  });
});

describe("PublicProfileForm owner name", () => {
  // D8 / migration 0141: the business name is the company, owner_name is the
  // person a homeowner ends up talking to. Every pro who signed up before the
  // question existed has to be able to fill it in here.
  //
  // Queried by field name, not by label: the labels in this form are plain
  // <label className="label"> with no htmlFor and no wrapping, so there is no
  // accessible association for getByLabelText to follow.
  function field(container: HTMLElement, name: string): HTMLInputElement {
    return container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  }

  it("renders an editable Owner Name field, prefilled from the row", () => {
    const { container } = render(
      <PublicProfileForm
        contractor={{ ...CONTRACTOR, owner_name: "Alex Rivera" }}
      />
    );
    const input = field(container, "owner_name");
    expect(input).toBeTruthy();
    expect(input).toHaveValue("Alex Rivera");
    expect(input).not.toHaveAttribute("readonly");
    // The column's own CHECK caps it at 120.
    expect(input.maxLength).toBe(120);
    expect(screen.getByText("Owner Name")).toBeInTheDocument();
  });

  it("leaves the field empty, not absent, for a company that predates the question", () => {
    const { container } = render(
      <PublicProfileForm contractor={{ ...CONTRACTOR, owner_name: null }} />
    );
    expect(field(container, "owner_name")).toHaveValue("");
  });

  // D7: the pro side must never lock the contact email to the account email. A
  // Sign in with Apple account carries a privaterelay.appleid.com forwarder,
  // which is not an address a homeowner should be sent to.
  it("keeps the contact email editable", () => {
    const { container } = render(<PublicProfileForm contractor={CONTRACTOR} />);
    const input = field(container, "contact_email");
    expect(input).toBeTruthy();
    expect(input).not.toHaveAttribute("readonly");
    expect(input).not.toBeDisabled();
  });
});
