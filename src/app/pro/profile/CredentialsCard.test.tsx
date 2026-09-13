// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Both action modules pull in the service-role Supabase client transitively
// (createAdminClient -> "server-only"), which throws the moment it is imported
// under jsdom. Mocked out exactly like PublicProfileForm.test.tsx mocks its own
// "use server" actions, so the real component renders with no server dependency.
// The save actions never resolve during the test, matching
// src/components/SubmitButton.test.tsx's own double-click test: a REAL server
// action is async and stays pending for at least one round trip, so `pending`
// from useFormStatus does not flip back to false (and reset the latch) between
// two synchronous clicks. A plain vi.fn() returning undefined would settle
// instantly and defeat the race the latch exists to stop.
const saveLicenseNumberAction = vi.fn(
  (..._args: unknown[]) => new Promise(() => {})
);
const verifyLicenseNowAction = vi.fn();
vi.mock("../actions", () => ({
  saveLicenseNumberAction: (...args: unknown[]) =>
    saveLicenseNumberAction(...args),
  verifyLicenseNowAction: (...args: unknown[]) => verifyLicenseNowAction(...args),
}));
const licenseDisputeAction = vi.fn();
const saveLicenseInsuranceAction = vi.fn(
  (..._args: unknown[]) => new Promise(() => {})
);
vi.mock("./actions", () => ({
  licenseDisputeAction: (...args: unknown[]) => licenseDisputeAction(...args),
  saveLicenseInsuranceAction: (...args: unknown[]) =>
    saveLicenseInsuranceAction(...args),
}));

import CredentialsCard from "./CredentialsCard";

afterEach(() => {
  cleanup();
  saveLicenseNumberAction.mockClear();
  saveLicenseInsuranceAction.mockClear();
});

// A minimal contractor row: only the fields CredentialsCard actually reads.
// `any`, not the generated Contractor type, since several of these (service_state,
// insurance_expires, the license_verify_detail shape) are cast with `as any`
// inside the component itself for the same not-yet-regenerated-types reason
// documented there.
const CONTRACTOR: any = {
  id: "c1",
  name: "Acme Plumbing",
  license_number: null,
  license_verified_status: null,
  license_verified_at: null,
  license_verify_detail: null,
  license_expires: null,
  license_doc_path: null,
  insurance_expires: null,
  insurance_doc_path: null,
  insurance_carrier: null,
  service_state: null,
};

function field(container: HTMLElement, name: string): HTMLInputElement | null {
  return container.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
}

describe("CredentialsCard: the license number form", () => {
  it("posts the number to saveLicenseNumberAction, not saveCompanyAction", () => {
    const { container } = render(<CredentialsCard contractor={CONTRACTOR} />);
    const input = field(container, "license_number");
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: "1029384" } });
    fireEvent.click(screen.getByRole("button", { name: /save license number/i }));
    expect(saveLicenseNumberAction).toHaveBeenCalledTimes(1);
  });

  // saveCompanyAction is NOT missing-field-safe about the company name and the
  // phone (both are required for a listing), so the credentials form could not
  // post there without being bounced with a message about fields it does not
  // show. It carries the same hidden service_state=CA the profile form does,
  // which is what the action reads to decide whether a CSLB check can run.
  it("carries the hidden service_state=CA the CSLB check keys off", () => {
    const { container } = render(<CredentialsCard contractor={CONTRACTOR} />);
    const hidden = field(container, "service_state");
    expect(hidden).toBeTruthy();
    expect(hidden!.value).toBe("CA");
    expect(hidden!.type).toBe("hidden");
  });

  it("submits once when the save button is clicked twice rapidly", () => {
    render(<CredentialsCard contractor={CONTRACTOR} />);
    const button = screen.getByRole("button", { name: /save license number/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(saveLicenseNumberAction).toHaveBeenCalledTimes(1);
  });

  it("has a stable id=license anchor for the deep link", () => {
    const { container } = render(<CredentialsCard contractor={CONTRACTOR} />);
    expect(container.querySelector("#license")).toBeTruthy();
  });
});

// The lock rule is the PROFILE FORM's, deliberately: correctable until a real
// CSLB check confirms it, NOT the "locked once set" rule
// saveLicenseInsuranceAction applies. A typo must stay fixable.
describe("CredentialsCard license lock", () => {
  it("keeps an unverified number editable", () => {
    const { container } = render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "1029384",
          license_verified_status: "pending",
        }}
      />
    );
    const input = field(container, "license_number");
    expect(input).toBeTruthy();
    expect(input).toHaveValue("1029384");
    expect(input).not.toHaveAttribute("readonly");
  });

  it("locks a verified number to read-only text with no input to post", () => {
    const { container } = render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "1029384",
          license_verified_status: "verified",
          license_verified_at: "2026-01-15T00:00:00.000Z",
        }}
      />
    );
    expect(field(container, "license_number")).toBeNull();
    expect(screen.getByText("1029384")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save license number/i })
    ).not.toBeInTheDocument();
  });
});

// Moved from PublicProfileForm.test.tsx (CEO pass D3): the license status badges
// carry meaning (verified / not confirmed / pending), so on a phone they step up
// to 14px instead of the old 12px. Desktop (base text-[10px], no max-sm prefix
// reaches it) is unchanged.
describe("CredentialsCard license status badges on a phone", () => {
  it("License verified: 14px on a phone, 10px above sm", () => {
    render(
      <CredentialsCard
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
      <CredentialsCard
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
      <CredentialsCard
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

describe("CredentialsCard verification and dispute controls", () => {
  it("offers Verify now for a CA-eligible pending license", () => {
    render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "pending",
          service_state: "CA",
        }}
      />
    );
    expect(
      screen.getByRole("button", { name: /verify now/i })
    ).toBeInTheDocument();
  });

  it("offers Reverify, not a dispute, for a plain CSLB failure", () => {
    render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "failed",
          license_verify_detail: { statusText: "Expired" },
          service_state: "CA",
        }}
      />
    );
    expect(screen.getByRole("button", { name: /reverify/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send dispute/i })
    ).not.toBeInTheDocument();
  });

  it("offers the dispute form, not Reverify, for an identity failure (0125)", () => {
    const { container } = render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "failed",
          license_verify_detail: { failure_reason: "name_mismatch" },
          service_state: "CA",
        }}
      />
    );
    expect(
      screen.getByRole("button", { name: /send dispute/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reverify/i })
    ).not.toBeInTheDocument();
    // licenseDisputeAction reads only this field off the form it posts.
    expect(container.querySelector('[name="message"]')).toBeTruthy();
  });

  it("tells a non-CA pro no automatic check will run, with no dead button", () => {
    render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "pending",
          service_state: "AZ",
        }}
      />
    );
    expect(
      screen.queryByRole("button", { name: /verify now|reverify/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/only cover California \(CSLB\)/i)
    ).toBeInTheDocument();
  });
});

describe("CredentialsCard documents", () => {
  it("renders the license and insurance upload rows, with the #insurance anchor", () => {
    const { container } = render(<CredentialsCard contractor={CONTRACTOR} />);
    expect(container.querySelector("#insurance")).toBeTruthy();
    expect(screen.getByText("Contractor license")).toBeInTheDocument();
    expect(screen.getByText("Insurance")).toBeInTheDocument();
  });

  // The number and its CSLB status are in the card directly above, so
  // ComplianceCard must not print a second copy of them.
  it("does not repeat the license number or its CSLB verdict", () => {
    render(
      <CredentialsCard
        contractor={{
          ...CONTRACTOR,
          license_number: "12345",
          license_verified_status: "verified",
        }}
      />
    );
    expect(screen.queryByText(/^License #/)).not.toBeInTheDocument();
    expect(screen.queryByText("Verified with the CSLB")).not.toBeInTheDocument();
  });

  it("says insurance is private and gates big jobs", () => {
    render(<CredentialsCard contractor={CONTRACTOR} />);
    expect(
      screen.getByText(
        "Never shown on your public page. Homeowners can ask you for a copy. Big jobs need current insurance on file before you can apply."
      )
    ).toBeInTheDocument();
  });
});

describe("CredentialsCard insurance carrier form", () => {
  it("posts the carrier to saveLicenseInsuranceAction", () => {
    const { container } = render(
      <CredentialsCard
        contractor={{ ...CONTRACTOR, insurance_carrier: "State Farm" }}
      />
    );
    const input = field(container, "insurance_carrier");
    expect(input).toBeTruthy();
    expect(input).toHaveValue("State Farm");
    fireEvent.click(screen.getByRole("button", { name: /save carrier/i }));
    expect(saveLicenseInsuranceAction).toHaveBeenCalledTimes(1);
  });

  // The upload row owns the expiry date (the /api/pro-compliance route reads it
  // off the uploaded document). A second input for it here, posted with the
  // carrier, would overwrite whatever the upload had just stored - which is the
  // reason saveLicenseInsuranceAction is missing-field-safe now.
  it("carries no insurance_expires input", () => {
    const { container } = render(<CredentialsCard contractor={CONTRACTOR} />);
    const form = container
      .querySelector('[name="insurance_carrier"]')!
      .closest("form")!;
    expect(form.querySelector('[name="insurance_expires"]')).toBeNull();
    expect(form.querySelector('[name="license_number"]')).toBeNull();
    expect(form.querySelector('[name="license_state"]')).toBeNull();
  });
});
