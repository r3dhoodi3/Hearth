// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import ReviewShareRow from "./ReviewShareRow";

const props = {
  reviewId: "review-1",
  rating: 5,
  comment: "Great work, fast and tidy.",
  profileUrl: "https://hearth.example/p/ace-plumbing",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ReviewShareRow", () => {
  it("offers a download link pointing at the review card", () => {
    render(<ReviewShareRow {...props} />);
    const download = screen.getByText("Download") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/review-card/review-1");
    expect(download.getAttribute("download")).toBe("hearth-review-review-1.png");
  });

  it("copies the caption with the profile URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<ReviewShareRow {...props} />);
    fireEvent.click(screen.getByText("Copy caption"));

    await waitFor(() => expect(screen.getByText("Copied!")).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(
      "Thanks for the kind words! Find me on Hearth: https://hearth.example/p/ace-plumbing"
    );
  });

  it("shares the review card as a file when the browser can accept files", async () => {
    const blob = new Blob(["fake-image-bytes"], { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(blob) })
    );
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    const canShareSpy = vi.fn().mockReturnValue(true);
    Object.defineProperty(window.navigator, "share", { value: shareSpy, configurable: true });
    Object.defineProperty(window.navigator, "canShare", {
      value: canShareSpy,
      configurable: true,
    });

    render(<ReviewShareRow {...props} />);
    fireEvent.click(screen.getByText("Share"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeDefined();
    expect(call.files[0]).toBeInstanceOf(File);
    expect(call.url).toBe(props.profileUrl);
  });

  it("falls back to a link-only share when the browser can't accept files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.reject(new Error("no")) })
    );
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "share", { value: shareSpy, configurable: true });
    Object.defineProperty(window.navigator, "canShare", {
      value: undefined,
      configurable: true,
    });

    render(<ReviewShareRow {...props} />);
    fireEvent.click(screen.getByText("Share"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeUndefined();
    expect(call.url).toBe(props.profileUrl);
  });

  it("opens the card in a new tab when no share API exists at all", async () => {
    Object.defineProperty(window.navigator, "share", { value: undefined, configurable: true });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<ReviewShareRow {...props} />);
    fireEvent.click(screen.getByText("Share"));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("/api/review-card/review-1", "_blank", "noreferrer")
    );
  });
});
