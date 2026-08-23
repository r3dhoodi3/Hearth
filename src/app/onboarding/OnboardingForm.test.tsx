// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The street box asks /api/address-suggest for suggestions as it is typed
// (OnboardingForm.tsx). Stubbed to "nothing found" by default so the existing
// tests below exercise the form exactly as they did before autocomplete
// existed; the suggestion tests further down replace it per-case.
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ suggestions: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

// The street box suggests real addresses in the launch area as it is typed
// (/api/address-suggest, backed by Photon). Everything here is a convenience
// over a free third-party geocoder, so the load-bearing case is the one where
// it fails: the field has to keep behaving exactly like a plain text box.
describe("OnboardingForm address suggestions", () => {
  const SUGGESTIONS = [
    {
      line1: "9842 Bolsa Avenue",
      city: "Westminster",
      state: "CA" as const,
      zip: "92844",
    },
    {
      line1: "9938 Bolsa Avenue",
      city: "Westminster",
      state: "CA" as const,
      zip: "92683",
    },
  ];

  function withSuggestions(suggestions = SUGGESTIONS) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions }),
    });
  }

  async function typeStreet(value: string) {
    render(<OnboardingForm />);
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value },
    });
    return screen.getByLabelText("Street address") as HTMLInputElement;
  }

  it("lists suggestions under the street field", async () => {
    withSuggestions();
    await typeStreet("9832 Bol");

    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("9842 Bolsa Avenue")).toBeInTheDocument();
    expect(screen.getByText("Westminster, CA 92844")).toBeInTheDocument();
  });

  it("sends the ZIP along so the query can name a city", async () => {
    withSuggestions();
    render(<OnboardingForm />);
    fireEvent.change(screen.getByLabelText("ZIP code"), {
      target: { value: "92683" },
    });
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "9832 Bol" },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(url).toContain("q=9832+Bol");
    expect(url).toContain("zip=92683");
  });

  it("asks for nothing until the query is long enough to be a search", async () => {
    withSuggestions();
    await typeStreet("98");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fills street and ZIP when a suggestion is tapped, without running the lookup", async () => {
    withSuggestions();
    const street = await typeStreet("9832 Bol");

    fireEvent.click(await screen.findByText("9938 Bolsa Avenue"));

    expect(street.value).toBe("9938 Bolsa Avenue");
    expect((screen.getByLabelText("ZIP code") as HTMLInputElement).value).toBe(
      "92683"
    );
    // Picking is not confirming. Continue is still what runs the lookup, so a
    // mis-tap costs nothing.
    expect(lookupParcelAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is drivable from the keyboard", async () => {
    withSuggestions();
    const street = await typeStreet("9832 Bol");
    await screen.findByRole("listbox");

    // Nothing highlighted yet, so Enter still belongs to Continue.
    expect(street.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(street, { key: "ArrowDown" });
    fireEvent.keyDown(street, { key: "ArrowDown" });
    expect(street.getAttribute("aria-activedescendant")).toBe(
      "street-suggestion-1"
    );
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.keyDown(street, { key: "ArrowUp" });
    expect(street.getAttribute("aria-activedescendant")).toBe(
      "street-suggestion-0"
    );

    fireEvent.keyDown(street, { key: "Enter" });
    expect(street.value).toBe("9842 Bolsa Avenue");
    // Enter chose the suggestion; it must NOT also have fired the lookup that
    // the form's own Enter handler runs during the address phase.
    expect(lookupParcelAction).not.toHaveBeenCalled();
  });

  it("closes on Escape and leaves what was typed alone", async () => {
    withSuggestions();
    const street = await typeStreet("9832 Bol");
    await screen.findByRole("listbox");

    fireEvent.keyDown(street, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(street.value).toBe("9832 Bol");
  });

  it("keeps the field working when the suggest route is down", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const street = await typeStreet("9871 Kings Canyon Dr");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(street.value).toBe("9871 Kings Canyon Dr");

    // And Continue still runs the lookup on what was typed by hand.
    lookupParcelAction.mockResolvedValue({ ok: true, facts: FACTS });
    fireEvent.change(screen.getByLabelText("ZIP code"), {
      target: { value: "92646" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Your full name")).toBeInTheDocument()
    );
  });
});

// An address the records source has never heard of must not become a home.
// lookupParcelAction refuses it (./actions.ts) and the form has to stop there
// rather than expanding into the claim section with an empty form.
describe("OnboardingForm not-found address", () => {
  const NOT_FOUND =
    "We couldn't find that address. Check the spelling or pick a suggestion.";

  async function submitFake() {
    lookupParcelAction.mockResolvedValue({
      ok: false,
      error: NOT_FOUND,
      notFound: true,
    });
    render(<OnboardingForm />);
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "123 Fake St" },
    });
    fireEvent.change(screen.getByLabelText("ZIP code"), {
      target: { value: "92648" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  }

  it("refuses to expand into the claim section", async () => {
    await submitFake();

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument();
    expect(screen.queryByLabelText("Your full name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Claim my home" })).toBeNull();
  });

  it("keeps the typed address so a one-character typo can be fixed in place", async () => {
    await submitFake();
    await screen.findByText(NOT_FOUND);

    expect(
      (screen.getByLabelText("Street address") as HTMLInputElement).value
    ).toBe("123 Fake St");
    expect((screen.getByLabelText("ZIP code") as HTMLInputElement).value).toBe(
      "92648"
    );
  });

  it("offers a way to clear it and start clean", async () => {
    await submitFake();
    await screen.findByText(NOT_FOUND);

    fireEvent.click(screen.getByRole("button", { name: "Try another address" }));

    expect(
      (screen.getByLabelText("Street address") as HTMLInputElement).value
    ).toBe("");
    expect((screen.getByLabelText("ZIP code") as HTMLInputElement).value).toBe(
      ""
    );
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
  });

  it("does not offer it for an ordinary error, which is fixed in place", async () => {
    lookupParcelAction.mockResolvedValue({
      ok: false,
      error: "Too many address lookups. Please try again in a bit.",
    });
    render(<OnboardingForm />);
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "9871 Kings Canyon Dr" },
    });
    fireEvent.change(screen.getByLabelText("ZIP code"), {
      target: { value: "92646" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText(/Too many address lookups/);
    expect(
      screen.queryByRole("button", { name: "Try another address" })
    ).toBeNull();
  });
});
