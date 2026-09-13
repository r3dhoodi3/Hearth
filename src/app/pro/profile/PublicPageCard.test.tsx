// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// "./actions" pulls in the service-role Supabase client transitively
// (createAdminClient -> "server-only"), which throws under jsdom. Mocked out
// the same way ReviewPrompt.test.tsx mocks its own "use server" actions.
// Never resolves during the test, matching src/components/SubmitButton.test.tsx's
// own double-click test: a REAL server action is async and stays pending for
// at least one network round trip, so `pending` from useFormStatus does not
// flip back to false (and reset the latch) between the two synchronous
// clicks below. A plain vi.fn() returning undefined would settle instantly
// and defeat the very race this test exists to catch.
const savePublicPageAction = vi.fn((..._args: unknown[]) => new Promise(() => {}));
vi.mock("./actions", () => ({
  savePublicPageAction: (...args: unknown[]) => savePublicPageAction(...args),
}));

// LogoUpload (rendered for a member) constructs the real browser Supabase
// client at render time, which throws without live project env vars. Only
// the constructor is ever reached in this test (no upload is triggered), so
// a bare stub is enough.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({}),
}));

import PublicPageCard from "./PublicPageCard";

afterEach(() => {
  cleanup();
  savePublicPageAction.mockClear();
});

const CONTRACTOR: any = {
  id: "c1",
  name: "Acme Plumbing",
  license_number: null,
  insurance_carrier: null,
  insurance_expires: null,
  license_state: null,
  logo_url: null,
  about: null,
};

describe("PublicPageCard's Save buttons: double-submit latch", () => {
  it("submits the member page-extras form once when clicked twice rapidly", () => {
    render(
      <PublicPageCard contractor={CONTRACTOR} member={true} trialEligible={false} />
    );
    const button = screen.getByRole("button", { name: /save page extras/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(savePublicPageAction).toHaveBeenCalledTimes(1);
  });
});

// This card used to carry its own "License and insurance" form: a SECOND
// license-number input (locked once merely set, unlike the profile form's
// correctable-until-verified rule), the license state, the carrier and the
// expiry date. All of it moved to the Credentials tab
// (./CredentialsCard.test.tsx). Two forms writing one license was how the two
// screens disagreed about when the number locks.
describe("PublicPageCard no longer owns license or insurance", () => {
  for (const member of [false, true]) {
    it(`renders no license or insurance fields (member: ${member})`, () => {
      const { container } = render(
        <PublicPageCard
          contractor={CONTRACTOR}
          member={member}
          trialEligible={false}
        />
      );
      for (const name of [
        "license_number",
        "license_state",
        "insurance_carrier",
        "insurance_expires",
      ]) {
        expect(container.querySelector(`[name="${name}"]`)).toBeNull();
      }
      expect(
        screen.queryByRole("button", { name: /save license and insurance/i })
      ).not.toBeInTheDocument();
    });
  }

  it("does not promise a license and insurance badge in the free-tier copy", () => {
    render(
      <PublicPageCard
        contractor={CONTRACTOR}
        member={false}
        trialEligible={false}
      />
    );
    expect(
      screen.queryByText(/license and insurance badge/i)
    ).not.toBeInTheDocument();
  });
});
