// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PrintButton from "./PrintButton";

afterEach(() => {
  cleanup();
});

describe("PrintButton: CR4#6 share line and button", () => {
  it("always shows the print button and the share-with line", () => {
    render(<PrintButton />);
    expect(screen.getByText("Print or save as PDF")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Share it with family, your realtor, or whoever buys the house next."
      )
    ).toBeInTheDocument();
  });

  it("clicking print triggers window.print", () => {
    const printSpy = vi.fn();
    Object.defineProperty(window, "print", { value: printSpy, configurable: true });
    render(<PrintButton />);
    fireEvent.click(screen.getByText("Print or save as PDF"));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("shows no Share button when the browser has no navigator.share", () => {
    Object.defineProperty(window.navigator, "share", { value: undefined, configurable: true });
    render(<PrintButton />);
    expect(screen.queryByText("Share")).toBeNull();
  });

  it("shows a Share button and shares the report link when navigator.share exists", async () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "share", { value: shareSpy, configurable: true });
    render(<PrintButton />);
    await waitFor(() => expect(screen.getByText("Share")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Share"));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    expect(shareSpy.mock.calls[0][0]).toEqual({
      title: "Home report",
      text: "Share it with family, your realtor, or whoever buys the house next.",
      url: window.location.href,
    });
  });
});
