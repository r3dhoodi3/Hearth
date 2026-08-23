// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const lookupParcelAction = vi.fn();
const claimPropertyAction = vi.fn();
const joinMarketWaitlistAction = vi.fn();

vi.mock("./actions", () => ({
  lookupParcelAction: (...args: unknown[]) => lookupParcelAction(...args),
  claimPropertyAction: (...args: unknown[]) => claimPropertyAction(...args),
  joinMarketWaitlistAction: (...args: unknown[]) =>
    joinMarketWaitlistAction(...args),
}));

import OnboardingForm from "./OnboardingForm";
import { LAUNCH_ONLY_MESSAGE } from "@/lib/serviceArea";

const FACTS = {
  parcel_id: "934-231-14",
  // Deliberately different from what gets typed below: this is the whole
  // point of the test, the canonicalised line the homeowner has to be able
  // to correct.
  address_line1: "9871 Kings Canyon Dr",
  city: "Huntington Beach",
  state: "CA",
  zip: "92646",
  year_built: 1968,
  sqft: 1432,
  beds: 3,
  baths: 2,
  lot_size_sqft: 6000,
  property_type: "single_family",
  purchase_date: null,
  purchase_price: null,
  assessed_value: null,
  assessed_year: null,
  property_tax_history: null,
  latitude: null,
  longitude: null,
  hoa_fee: null,
  county: "Orange",
  market_value: null,
  market_value_low: null,
  market_value_high: null,
  system_facts: null,
  source: "rentcast" as const,
};

async function toReadyStep() {
  // lookupParcelAction returns an ActionResult-style object now, not the bare
  // facts: a thrown server-action message is masked by Next in production, so
  // every user-facing refusal it makes is RETURNED instead (see ./actions.ts).
  lookupParcelAction.mockResolvedValue({ ok: true, facts: FACTS });
  const view = render(<OnboardingForm />);
  fireEvent.change(screen.getByLabelText("Street address"), {
    target: { value: "9871 kings canyon drive" },
  });
  fireEvent.change(screen.getByLabelText("ZIP code"), {
    target: { value: "92646" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getByLabelText("Your full name")).toBeInTheDocument());
  return view;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("OnboardingForm ready step", () => {
  it("posts the address from an editable field, not a hidden one", async () => {
    const { container } = await toReadyStep();

    const street = screen.getByLabelText("Street address") as HTMLInputElement;
    // The field the claim actually reads.
    expect(street.name).toBe("address_line1");
    expect(street.readOnly).toBe(false);
    // Seeded with the county's canonical line, not what was typed.
    expect(street.value).toBe("9871 Kings Canyon Dr");
    // ...and correctable.
    fireEvent.change(street, { target: { value: "9871 Kings Canyon Drive" } });
    expect(street.value).toBe("9871 Kings Canyon Drive");

    // No hidden duplicate left to override it.
    expect(
      container.querySelector('input[type="hidden"][name="address_line1"]')
    ).toBeNull();

    // Unit stays editable too; the ZIP is the one field that locks, because
    // changing it invalidates every looked-up fact on screen.
    expect((screen.getByLabelText(/Unit or apt/) as HTMLInputElement).readOnly).toBe(
      false
    );
    expect((screen.getByLabelText("ZIP code") as HTMLInputElement).readOnly).toBe(
      true
    );

    // The summary is advisory now.
    expect(screen.getByText(/County record:/)).toBeInTheDocument();
  });

  it("only lets Enter submit from the name field", async () => {
    const { container } = await toReadyStep();

    const enter = (el: Element) =>
      fireEvent.keyDown(el, { key: "Enter", code: "Enter" });

    // fireEvent returns false when the handler called preventDefault, which
    // is what stops the browser's implicit submit.
    const yearBuilt = container.querySelector('input[name="year_built"]')!;
    expect(enter(yearBuilt)).toBe(false);
    expect(enter(container.querySelector('input[name="sqft"]')!)).toBe(false);
    expect(enter(screen.getByLabelText("Street address"))).toBe(false);
    expect(enter(screen.getByLabelText(/Unit or apt/))).toBe(false);

    // The one field where Enter means "I'm done, claim it".
    expect(enter(screen.getByLabelText("Your full name"))).toBe(true);

    expect(claimPropertyAction).not.toHaveBeenCalled();
  });

  it("caps the name field at the ceiling the server enforces", async () => {
    await toReadyStep();
    expect(
      (screen.getByLabelText("Your full name") as HTMLInputElement).maxLength
    ).toBe(200);
  });

  it("looks the address up by street and ZIP only", async () => {
    await toReadyStep();
    expect(lookupParcelAction).toHaveBeenCalledWith(
      "9871 kings canyon drive",
      "92646",
      null
    );
  });

  // The street box is editable, but every parcel fact next to it is a hidden
  // copy of the ORIGINAL lookup. claimPropertyAction can only tell the two
  // apart if the form says what the lookup actually returned, so this field is
  // what makes the correction path safe.
  it("posts the looked-up line alongside the editable one", async () => {
    const { container } = await toReadyStep();

    const hidden = container.querySelector(
      'input[type="hidden"][name="looked_up_address"]'
    ) as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe("9871 Kings Canyon Dr");

    // Correcting the visible field must not touch it - it is the record of
    // what was looked up, not a mirror of what is being claimed.
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "9871 Kings Canyon Drive" },
    });
    expect(hidden.value).toBe("9871 Kings Canyon Dr");
  });
});

// lookupParcelAction RETURNS its refusals (./actions.ts) because Next masks the
// message of anything a server action throws once it is in production. These
// two cover the caller's side of that contract: a returned error has to reach
// the screen, and the out-of-area one has to open the waitlist panel rather
// than render as an inline error.
describe("OnboardingForm lookup refusals", () => {
  async function submitAddress() {
    render(<OnboardingForm />);
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "9871 kings canyon drive" },
    });
    // A launch ZIP, so the form's own client-side check passes it through and
    // the SERVER's answer is what decides - which is the path under test.
    fireEvent.change(screen.getByLabelText("ZIP code"), {
      target: { value: "92646" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  it("shows a returned error inline instead of the generic fallback", async () => {
    lookupParcelAction.mockResolvedValue({
      ok: false,
      error: "Too many address lookups. Please try again in a bit.",
    });
    await submitAddress();

    expect(
      await screen.findByText("Too many address lookups. Please try again in a bit.")
    ).toBeInTheDocument();
    // Still on the address step, not expanded into the claim section.
    expect(screen.queryByLabelText("Your full name")).toBeNull();
  });

  it("opens the waitlist panel when the server says out of area", async () => {
    lookupParcelAction.mockResolvedValue({
      ok: false,
      error: LAUNCH_ONLY_MESSAGE,
      waitlisted: true,
    });
    await submitAddress();

    expect(
      await screen.findByText(/Hearth isn't in your area yet/i)
    ).toBeInTheDocument();
    expect(screen.getByText(LAUNCH_ONLY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't save you to the waitlist/i)).toBeNull();
  });

  it("says so honestly when the waitlist save itself failed", async () => {
    lookupParcelAction.mockResolvedValue({
      ok: false,
      error: LAUNCH_ONLY_MESSAGE,
      waitlisted: false,
    });
    await submitAddress();

    expect(
      await screen.findByText(/couldn't save you to the waitlist/i)
    ).toBeInTheDocument();
  });
});

// A unit number means the county's record for this street line is the whole
// building's, so there is no owner of record for this home to check a name
// against. The copy has to say that rather than promise a check that is not
// run (claimPropertyAction records the claim as unverified instead).
describe("OnboardingForm ownership copy", () => {
  it("promises the county check for a single-family claim", async () => {
    await toReadyStep();
    expect(
      screen.getByText(/compare the name on your account against the county/i)
    ).toBeInTheDocument();
  });

  it("stops promising it once a unit is entered", async () => {
    await toReadyStep();
    fireEvent.change(screen.getByLabelText(/Unit or apt/), {
      target: { value: "4B" },
    });

    expect(
      screen.queryByText(/compare the name on your account against the county/i)
    ).toBeNull();
    expect(
      screen.getByText(/Public records only go down to the building/i)
    ).toBeInTheDocument();
  });
});
