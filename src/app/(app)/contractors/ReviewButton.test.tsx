// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// getMyInviteCodeAction ultimately reaches createClient() (server-only), so
// it's mocked the same way any "use server" import is in a client-component
// test: resolved to null, which simply keeps the separate "Invite a
// neighbor" panel out of the way for these photo-share tests.
vi.mock("./inviteActions", () => ({
  getMyInviteCodeAction: vi.fn().mockResolvedValue(null),
}));

import ReviewButton from "./ReviewButton";

async function submitRating(stars: number) {
  fireEvent.click(screen.getByText("Leave a review"));
  fireEvent.click(screen.getByLabelText(`${stars} star${stars > 1 ? "s" : ""}`));
  fireEvent.click(screen.getByText("Submit"));
  await waitFor(() => expect(screen.queryByText("How was Ace Plumbing?")).toBeNull());
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ReviewButton: photo share (CR4#2)", () => {
  it("labels the button 'Share' with no photoUrl (unchanged behavior)", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    render(
      <ReviewButton
        leadId="lead-1"
        contractorName="Ace Plumbing"
        action={action}
        proProfilePath="/p/ace"
        categoryLabel="Plumbing"
      />
    );
    await submitRating(5);
    expect(screen.getByText("Share")).toBeInTheDocument();
    expect(screen.queryByText("Share photo")).toBeNull();
  });

  it("labels the button 'Share photo' when the job has a photo attached", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
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
    await submitRating(5);
    expect(screen.getByText("Share photo")).toBeInTheDocument();
  });

  it("shares the photo as a file when the browser can accept files", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    const blob = new Blob(["fake-image-bytes"], { type: "image/jpeg" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: () => Promise.resolve(blob) }));
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    const canShareSpy = vi.fn().mockReturnValue(true);
    Object.defineProperty(window.navigator, "share", { value: shareSpy, configurable: true });
    Object.defineProperty(window.navigator, "canShare", {
      value: canShareSpy,
      configurable: true,
    });

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
    await submitRating(5);
    fireEvent.click(screen.getByText("Share photo"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeDefined();
    expect(call.files[0]).toBeInstanceOf(File);
    // Never falls back to the link when the file share succeeded.
    expect(call.url).toBeUndefined();
  });

  it("falls back to the link share when the browser can't accept files", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: () => Promise.reject(new Error("no")) }));
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "share", { value: shareSpy, configurable: true });
    // No navigator.canShare at all: the file branch is skipped entirely.
    Object.defineProperty(window.navigator, "canShare", {
      value: undefined,
      configurable: true,
    });

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
    await submitRating(4);
    fireEvent.click(screen.getByText("Share photo"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.url).toBe(`${window.location.origin}/p/ace`);
    expect(call.files).toBeUndefined();
  });
});
