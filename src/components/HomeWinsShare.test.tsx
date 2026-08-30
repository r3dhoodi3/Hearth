// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import HomeWinsShare from "./HomeWinsShare";
import type { HomeWins } from "@/lib/homeWins";

const wins: HomeWins = {
  variant: "active",
  firstName: "Jamie",
  wins: [{ key: "great", text: "3 systems in great shape" }],
  hasRealWin: true,
};

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("HomeWinsShare", () => {
  it("renders and offers a download image link pointing at the wins card", async () => {
    render(<HomeWinsShare wins={wins} code="ABCD1234" />);
    await waitFor(() =>
      expect(screen.getByText("Share your home wins")).toBeInTheDocument()
    );
    const download = screen.getByText("Download image") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/wins-card/ABCD1234");
    expect(download.getAttribute("download")).toBe("hearth-home-wins.png");
  });

  it("shares the wins card as a file when the browser can accept files", async () => {
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

    render(<HomeWinsShare wins={wins} code="ABCD1234" />);
    await waitFor(() => expect(screen.getByText("Share your home wins")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Share"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeDefined();
    expect(call.files[0]).toBeInstanceOf(File);
    // The referral link still rides along as secondary attribution.
    expect(call.url).toContain("?ref=ABCD1234");
  });

  it("falls back to a link-only share when the browser can't accept files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.reject(new Error("no")) })
    );
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "share", { value: shareSpy, configurable: true });
    // No navigator.canShare at all: the file branch is skipped entirely.
    Object.defineProperty(window.navigator, "canShare", {
      value: undefined,
      configurable: true,
    });

    render(<HomeWinsShare wins={wins} code="ABCD1234" />);
    await waitFor(() => expect(screen.getByText("Share your home wins")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Share"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeUndefined();
    expect(call.url).toContain("?ref=ABCD1234");
  });

  it("falls back to clipboard when no navigator.share exists at all", async () => {
    Object.defineProperty(window.navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    render(<HomeWinsShare wins={wins} code="ABCD1234" />);
    await waitFor(() => expect(screen.getByText("Share your home wins")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Share"));

    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
  });
});
