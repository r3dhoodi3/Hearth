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
vi.mock("../actions", () => ({
  saveCompanyAction: (...args: unknown[]) => saveCompanyAction(...args),
}));
const saveLogoAction = vi.fn();
const saveBannerAction = vi.fn();
vi.mock("./actions", () => ({
  saveLogoAction: (...args: unknown[]) => saveLogoAction(...args),
  saveBannerAction: (...args: unknown[]) => saveBannerAction(...args),
}));

// AvatarUpload (the profile photo control) constructs the real browser Supabase
// client at render time, which throws without live project env vars. Only the
// constructor is reached here (no upload is triggered), so a bare stub is
// enough - same treatment as PublicPageCard.test.tsx.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({}),
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

// The profile photo is FREE for every pro as of 2026-09-08 and is uploaded by
// tapping the avatar itself (AvatarUpload). The old dead "Change Cover" button
// is still gone, and the placeholder that used to point at the Pro-gated "Your
// Public Page" tab is now a real tappable upload instead of a pointer
// elsewhere. These tests pin that.
describe("PublicProfileForm photo control", () => {
  it("renders no 'Change Cover' control", () => {
    render(<PublicProfileForm contractor={CONTRACTOR} />);
    expect(
      screen.queryByRole("button", { name: /change cover/i })
    ).not.toBeInTheDocument();
  });

  it("offers a tappable photo upload and no longer points to the Your Public Page tab", () => {
    const { container } = render(<PublicProfileForm contractor={CONTRACTOR} />);
    expect(screen.queryByText("+")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/add a logo from the "your public page" tab/i)
    ).not.toBeInTheDocument();
    // The whole avatar is the control: a hidden file input wired for images.
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    expect(fileInput?.accept).toContain("image/");
  });
});

// The license number, its verified / not-confirmed / pending badges, the CSLB
// copy, "Verify now" and the dispute form all moved to the Credentials tab.
// Their own tests live in ./CredentialsCard.test.tsx; what this form owes is
// that none of it is still here, so a pro can never edit the same number in two
// places under two different lock rules.
describe("PublicProfileForm no longer owns the license number", () => {
  it("renders no license_number field and no license badges", () => {
    const { container } = render(
      <PublicProfileForm
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "verified",
        }}
      />
    );
    expect(container.querySelector('[name="license_number"]')).toBeNull();
    expect(screen.queryByText("State License Number")).not.toBeInTheDocument();
    expect(screen.queryByText("License verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Not confirmed")).not.toBeInTheDocument();
    expect(screen.queryByText("Verification pending")).not.toBeInTheDocument();
  });

  it("offers no Verify now / Reverify button and no dispute form", () => {
    const { container } = render(
      <PublicProfileForm
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "failed",
          license_verify_detail: { failure_reason: "name_mismatch" },
        }}
      />
    );
    expect(
      screen.queryByRole("button", { name: /verify now|reverify/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send dispute/i })
    ).not.toBeInTheDocument();
    expect(container.querySelector("#license_dispute_message")).toBeNull();
  });
});

// The outbound Yelp / Google review links (0110/0111/0113) are gone from every
// user-facing surface as of 2026-09-12: an outbound link is a route off the
// platform before any lead record exists. The columns and saveCompanyAction's
// handling of them stay, and that handling is missing-field-safe, so a form
// that no longer posts the fields leaves whatever is stored untouched.
describe("PublicProfileForm no longer asks for review links", () => {
  it("renders no yelp_url or google_reviews_url inputs", () => {
    const { container } = render(
      <PublicProfileForm
        contractor={{
          ...CONTRACTOR,
          yelp_url: "https://www.yelp.com/biz/acme-plumbing",
          google_reviews_url: "https://g.page/acme-plumbing",
        }}
      />
    );
    expect(container.querySelector('[name="yelp_url"]')).toBeNull();
    expect(container.querySelector('[name="google_reviews_url"]')).toBeNull();
    expect(screen.queryByText(/yelp/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/google reviews/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/see our reviews/i)).not.toBeInTheDocument();
    // The anchor the old setup-checklist step deep-linked to went with them.
    expect(container.querySelector("#reviews")).toBeNull();
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
