// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import WinShareButton from "./WinShareButton";

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("WinShareButton", () => {
  it("offers a download link pointing at the win card", () => {
    render(<WinShareButton leadId="lead-1" businessName="Ace Plumbing" />);
    const download = screen.getByText("Download") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/win-card/lead-1");
    expect(download.getAttribute("download")).toBe("hearth-win-ace-plumbing.png");
  });

  it("shares the win card as a file when the browser can accept files", async () => {
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

    render(<WinShareButton leadId="lead-1" businessName="Ace Plumbing" />);
    fireEvent.click(screen.getByText("Share this win"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeDefined();
    expect(call.files[0]).toBeInstanceOf(File);
  });

  it("falls back to a text-only share when the browser can't accept files", async () => {
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

    render(<WinShareButton leadId="lead-1" businessName="Ace Plumbing" />);
    fireEvent.click(screen.getByText("Share this win"));

    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const call = shareSpy.mock.calls[0][0];
    expect(call.files).toBeUndefined();
    expect(call.text).toBe("We just won a job on Hearth!");
  });

  it("opens the card in a new tab when no share API exists at all", async () => {
    Object.defineProperty(window.navigator, "share", { value: undefined, configurable: true });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(<WinShareButton leadId="lead-1" businessName="Ace Plumbing" />);
    fireEvent.click(screen.getByText("Share this win"));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(
      "/api/win-card/lead-1",
      "_blank",
      "noopener,noreferrer"
    ));
  });
});
