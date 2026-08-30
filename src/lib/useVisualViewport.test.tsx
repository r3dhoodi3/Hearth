// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useChatViewport, useIsPhone } from "./useVisualViewport";

// The reported bug: on an iPhone, typing scrolled what you were typing off the
// screen. iOS Safari does not shrink 100dvh for the keyboard, it shrinks
// window.visualViewport and then scrolls the document to "reveal" the field.
// These are the four numbers the CSS panel is built from, plus the body class
// that gets the bottom tab bar out of the keyboard's way.

type FakeViewport = {
  height: number;
  offsetTop: number;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
  fire: (t: string) => void;
};

function fakeViewport(height: number, offsetTop = 0): FakeViewport {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    height,
    offsetTop,
    listeners,
    addEventListener(t, fn) {
      (listeners[t] ||= []).push(fn);
    },
    removeEventListener(t, fn) {
      listeners[t] = (listeners[t] || []).filter((f) => f !== fn);
    },
    fire(t) {
      (listeners[t] || []).forEach((fn) => fn());
    },
  };
}

function Panel() {
  useChatViewport();
  return <div data-testid="panel" />;
}

const varOf = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

let vv: FakeViewport;

beforeEach(() => {
  document.body.innerHTML = "";
  // A 56px sticky header and a 56px bottom tab bar, the two things the panel
  // has to sit between. Measured at runtime, never hardcoded, so the test
  // hands them real-ish geometry.
  const header = document.createElement("header");
  header.getBoundingClientRect = () => ({ height: 56 }) as DOMRect;
  document.body.appendChild(header);
  const tabs = document.createElement("nav");
  tabs.className = "fixed inset-x-0 bottom-0 z-30";
  tabs.getBoundingClientRect = () => ({ height: 56 }) as DOMRect;
  document.body.appendChild(tabs);

  vv = fakeViewport(800);
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: vv,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 800,
    writable: true,
  });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  document.body.className = "";
});

describe("useChatViewport", () => {
  it("mirrors the visual viewport, the header and the tab bar onto <html>", () => {
    render(<Panel />);
    expect(varOf("--hearth-vvh")).toBe("800px");
    expect(varOf("--hearth-kb")).toBe("0px");
    expect(varOf("--hearth-chat-top")).toBe("56px");
    expect(varOf("--hearth-chat-bottom")).toBe("56px");
    expect(document.body.classList.contains("hearth-kb-open")).toBe(false);
  });

  it("shrinks the panel and marks the body when the keyboard opens", () => {
    render(<Panel />);
    act(() => {
      vv.height = 460; // 340px of keyboard
      vv.fire("resize");
    });
    expect(varOf("--hearth-vvh")).toBe("460px");
    expect(varOf("--hearth-kb")).toBe("340px");
    // The tab bar is hidden by the body class, so it takes no room: the panel
    // runs all the way down to the keys.
    expect(varOf("--hearth-chat-bottom")).toBe("0px");
    expect(document.body.classList.contains("hearth-kb-open")).toBe(true);
  });

  it("ignores the URL bar collapsing, which would flicker the tab bar on every scroll", () => {
    render(<Panel />);
    act(() => {
      vv.height = 740; // 60px, far too little to be a keyboard
      vv.fire("resize");
    });
    expect(document.body.classList.contains("hearth-kb-open")).toBe(false);
    expect(varOf("--hearth-chat-bottom")).toBe("56px");
  });

  it("undoes Safari's document shove while the composer has focus", () => {
    const { getByTestId } = render(
      <>
        <Panel />
        <textarea data-testid="composer" />
      </>
    );
    (getByTestId("composer") as HTMLTextAreaElement).focus();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 220 });
    act(() => {
      vv.height = 460;
      vv.fire("resize");
    });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("puts everything back on unmount, so a non-chat screen is never left sized to a stale keyboard", () => {
    const view = render(<Panel />);
    act(() => {
      vv.height = 460;
      vv.fire("resize");
    });
    view.unmount();
    expect(varOf("--hearth-vvh")).toBe("");
    expect(varOf("--hearth-kb")).toBe("");
    expect(varOf("--hearth-chat-top")).toBe("");
    expect(varOf("--hearth-chat-bottom")).toBe("");
    expect(document.body.classList.contains("hearth-kb-open")).toBe(false);
  });

  it("writes nothing at all where visualViewport does not exist", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
    render(<Panel />);
    expect(varOf("--hearth-vvh")).toBe("");
  });
});

function Phone() {
  return <span data-testid="phone">{useIsPhone() ? "phone" : "desktop"}</span>;
}

describe("useIsPhone", () => {
  it("starts on desktop so the server render and the first client render agree", () => {
    const { getByTestId } = render(<Phone />);
    expect(getByTestId("phone").textContent).toBe("desktop");
  });

  it("settles on phone when the media query matches", () => {
    const listeners: Array<() => void> = [];
    window.matchMedia = ((q: string) => ({
      media: q,
      matches: true,
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const { getByTestId } = render(<Phone />);
    expect(getByTestId("phone").textContent).toBe("phone");
  });
});
