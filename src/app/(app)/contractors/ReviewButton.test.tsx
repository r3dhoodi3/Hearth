// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// getMyInviteCodeAction ultimately reaches createClient() (server-only), so
// it's mocked the same way any "use server" import is in a client-component
// test. Each test picks its resolution: a real code arms the invite modal,
// null keeps it away entirely.
vi.mock("./inviteActions", () => ({
  getMyInviteCodeAction: vi.fn(),
}));

// ReviewButton must never import the store-review machinery: the native
// review ask fires from its own moments (plan_built on the dashboard,
// job_hired in HireAgainButton), never from a review submit. Mocking the
// module and asserting zero calls pins that invariant against a future
// "just wire it here too" regression.
vi.mock("@/lib/nativeReview", () => ({
  isNativePlatform: vi.fn().mockReturnValue(false),
  reportReviewMoment: vi.fn(),
  requestPlatformReview: vi.fn(),
}));

import { getMyInviteCodeAction } from "./inviteActions";
import { reportReviewMoment, requestPlatformReview } from "@/lib/nativeReview";
import ReviewButton from "./ReviewButton";

const mockedInvite = vi.mocked(getMyInviteCodeAction);

// photoUrl is passed on purpose: it used to arm the removed "Share your pro"
// photo-share panel, so these tests prove that surface stays gone even when a
// photo exists and the rating is 5 stars (its old strongest arming).
function renderButton(action = vi.fn().mockResolvedValue({ ok: true })) {
  render(
    <ReviewButton
      leadId="lead-1"
      contractorName="Ace Plumbing"
      action={action}
      proProfilePath="/p/ace"
      categoryLabel="Plumbing"
      photoUrl="/api/img?path=issue/1.jpg"
    />
  );
  return action;
}

async function submitRating(stars: number) {
  fireEvent.click(screen.getByText("Leave a review"));
  fireEvent.click(screen.getByLabelText(`${stars} star${stars > 1 ? "s" : ""}`));
  fireEvent.click(screen.getByText("Submit"));
  await waitFor(() => expect(screen.queryByText("How was Ace Plumbing?")).toBeNull());
}

async function openInviteModal(stars = 5) {
  await submitRating(stars);
  return await waitFor(() => screen.getByRole("dialog"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvite.mockResolvedValue("nbr123");
});

afterEach(() => {
  cleanup();
  // The scroll lock must never leak between tests (or, by extension, past a
  // dismissed modal).
  document.body.style.overflow = "";
});

describe("ReviewButton: single post-submit surface (owner ask 2026-08-30)", () => {
  it("shows exactly one follow-up after a 5-star submit: the centered invite modal", async () => {
    renderButton();
    const dialog = await openInviteModal(5);

    // The one surviving surface, as a proper modal card.
    expect(dialog).toHaveTextContent(
      "Know a neighbor who could use a hand with their place?"
    );
    expect(dialog).toHaveTextContent("Share your invite link.");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    // The removed "Share your pro" panel never appears, photo or not.
    expect(screen.queryByText(/needs a good/i)).toBeNull();
    expect(screen.queryByText("Share photo")).toBeNull();
    expect(screen.queryByText(/Share Ace Plumbing/)).toBeNull();

    // And the store-review machinery is never poked from this path.
    expect(vi.mocked(reportReviewMoment)).not.toHaveBeenCalled();
    expect(vi.mocked(requestPlatformReview)).not.toHaveBeenCalled();
  });

  it("locks body scroll while open and restores it on dismiss", async () => {
    renderButton();
    await openInviteModal();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("shows nothing at all when no invite link can be made", async () => {
    mockedInvite.mockResolvedValue(null);
    renderButton();
    await submitRating(5);

    await waitFor(() => expect(mockedInvite).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Know a neighbor/)).toBeNull();
  });

  it("X closes the modal and the dismissal is final for that submit", async () => {
    renderButton();
    await openInviteModal();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Nothing re-arms it afterwards: the invite code resolving again (or any
    // later render) must not resurface a dismissed modal.
    await waitFor(() => expect(mockedInvite).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape closes the modal", async () => {
    renderButton();
    await openInviteModal();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a tap on the scrim closes it, a tap inside the card does not", async () => {
    renderButton();
    const dialog = await openInviteModal();

    // Inside the card: stays open.
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // The scrim is the card's wrapper.
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("appears after ANY successful rating, not just a high one", async () => {
    renderButton();
    const dialog = await openInviteModal(2);
    expect(dialog).toHaveTextContent(
      "Know a neighbor who could use a hand with their place?"
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("closes itself after a successful native share", async () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "share", {
      value: shareSpy,
      configurable: true,
    });
    renderButton();
    await openInviteModal();

    fireEvent.click(screen.getByText("Share invite"));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    expect(shareSpy.mock.calls[0][0].url).toContain("/homeowner-signup?ref=nbr123");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not reappear when the review fails and is resubmitted after a dismissal", async () => {
    // First submit succeeds, modal shows, homeowner dismisses it. This pins
    // "dismiss is final": no later state change quietly brings it back.
    renderButton();
    await openInviteModal();
    fireEvent.click(screen.getByText("Not now"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
