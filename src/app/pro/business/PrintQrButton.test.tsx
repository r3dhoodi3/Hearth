// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The dynamic import("qrcode") inside the click handler resolves to this
// mock instead of the real encoder - the composition logic is what this
// test covers, not the QR encoding itself (QrCodeCard's own use of the same
// package is unchanged).
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,fakeqr"),
  },
}));

import PrintQrButton from "./PrintQrButton";

// jsdom's <canvas> has no real 2D backend (no "canvas" npm package
// installed, deliberately - see the component comment on why no new
// dependency was added). getContext is stubbed with a fake recording every
// call so the composition path (fillText, drawImage, measureText for the
// font auto-fit) can be asserted without a real renderer.
function stubCanvasContext() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textBaseline: "",
    fillRect: (...args: unknown[]) => calls.push(`fillRect:${JSON.stringify(args)}`),
    drawImage: (...args: unknown[]) => calls.push(`drawImage`),
    fillText: (text: string) => calls.push(`fillText:${text}`),
    measureText: (text: string) => ({ width: Math.min(text.length * 10, 2000) }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,fakecomposite"
  );
  return calls;
}

// jsdom's Image never fires a real decode; resolve onload on the next tick
// so the component's `await new Promise(...)` around image loading settles.
// Patches the src accessor directly on HTMLImageElement.prototype (rather
// than subclassing Image and swapping the global) so `new Image()` inside
// the component - which resolves the global Image at call time - is
// guaranteed to pick this up on the exact instance it creates.
function stubImageAutoLoad() {
  const proto = window.HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "src");
  Object.defineProperty(proto, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return original?.get?.call(this) ?? "";
    },
    set(this: HTMLImageElement, value: string) {
      original?.set?.call(this, value);
      setTimeout(() => (this as unknown as GlobalEventHandlers).onload?.(new Event("load")), 0);
    },
  });
  return () => {
    if (original) Object.defineProperty(proto, "src", original);
  };
}

let clickSpy: ReturnType<typeof vi.fn>;
let createdAnchors: HTMLAnchorElement[];
let restoreImage: () => void;

beforeEach(() => {
  clickSpy = vi.fn();
  createdAnchors = [];
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const el = realCreateElement(tag) as HTMLElement;
    if (tag === "a") {
      Object.defineProperty(el, "click", { value: clickSpy, configurable: true });
      createdAnchors.push(el as HTMLAnchorElement);
    }
    return el;
  });
  restoreImage = stubImageAutoLoad();
});

afterEach(() => {
  restoreImage();
  vi.restoreAllMocks();
  cleanup();
});

describe("PrintQrButton (CR4#3)", () => {
  it("composes and downloads a PNG with the profile link and business name", async () => {
    stubCanvasContext();
    render(<PrintQrButton url="https://hearth.com/p/ace-plumbing" businessName="Ace Plumbing" />);
    fireEvent.click(screen.getByRole("button", { name: "Print your QR code" }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    const anchor = createdAnchors[createdAnchors.length - 1];
    expect(anchor.download).toBe("hearth-qr-print-ace-plumbing.png");
    expect(anchor.href).toBe("data:image/png;base64,fakecomposite");
    expect(screen.queryByText(/Couldn/)).toBeNull();
  });

  it("shows an inline error instead of throwing when canvas is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<PrintQrButton url="https://hearth.com/p/ace-plumbing" businessName="Ace Plumbing" />);
    fireEvent.click(screen.getByRole("button", { name: "Print your QR code" }));

    await waitFor(() =>
      expect(screen.getByText("Couldn't generate the image. Try again.")).toBeInTheDocument()
    );
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
