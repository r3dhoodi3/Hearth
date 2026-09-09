// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The tour navigates to each step's page itself, so it needs both halves of
// the navigation API mocked.
let mockPathname = "/dashboard";
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}));

import SpotlightTour, {
  HOMEOWNER_STEPS,
  TOUR_TARGET_TIMEOUT_MS,
  spotlightPath,
} from "./SpotlightTour";

// The engine itself: target finding, the cutout, the fallback, the controls.
// The gate around it (when the tour opens at all, snoozing, the seen stamp)
// is AppGuide's job and is tested in AppGuide.test.tsx.

const onClose = vi.fn();
const onTourNavigate = vi.fn();

function renderTour() {
  return render(
    <SpotlightTour
      side="homeowner"
      onClose={onClose}
      onTourNavigate={onTourNavigate}
    />
  );
}

// jsdom lays nothing out, so every element measures 0x0 (which the engine
// reads as "hidden") until a test hands it a real rect.
function fakeRect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}

// Elements appended straight to document.body, outside the render container,
// so they play the part of the real page under the overlay. Tracked for
// removal because testing-library's cleanup only clears its own containers.
const planted: HTMLElement[] = [];
function plantTarget(className: string, rect: DOMRect): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.getBoundingClientRect = () => rect;
  document.body.appendChild(el);
  planted.push(el);
  return el;
}

beforeEach(() => {
  mockPathname = "/dashboard";
  mockPush.mockClear();
  onClose.mockClear();
  onTourNavigate.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  for (const el of planted.splice(0)) el.remove();
  vi.useRealTimers();
});

describe("SpotlightTour - anchoring", () => {
  it("rings the step's element and dims everything else when the target is on the page", () => {
    // The first homeowner step targets the dashboard's .card-hero score card.
    plantTarget("card-hero", fakeRect(40, 100, 200, 80));
    renderTour();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_STEPS[0].title)).toBeInTheDocument();

    // The scrim is the SVG with the cutout, not the flat fallback.
    expect(screen.getByTestId("tour-cutout")).toBeInTheDocument();
    expect(screen.queryByTestId("tour-scrim")).not.toBeInTheDocument();

    // The ring hugs the element's rect plus the 8px breathing room.
    const ring = screen.getByTestId("tour-ring");
    expect(ring.style.left).toBe("32px");
    expect(ring.style.top).toBe("92px");
    expect(ring.style.width).toBe("216px");
    expect(ring.style.height).toBe("96px");

    // The pulse is opt-in via motion-safe, so reduced-motion users get a
    // still ring rather than a throbbing one.
    expect(ring.className).toContain("motion-safe:animate-pulse");

    // The card sits below the cutout (a target in the top half of a 768px
    // viewport): cutout bottom 188 plus the 12px gap.
    const card = screen.getByRole("dialog");
    expect(card.style.top).toBe("200px");
  });

  it("hugs a toolbar pill tighter than a page card (3px breathing room, not 8)", () => {
    // The 4th homeowner step points at the Messages tab, a nav link. A pill is
    // small and already padded, so its ring uses the tight 3px pad instead of
    // the roomy 8px a big page card gets (asserted above for .card-hero).
    renderTour();
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }

    // The nav rendition of the Messages tab appears after we land on the step.
    const nav = document.createElement("nav");
    const link = document.createElement("a");
    link.setAttribute("href", "/chats");
    link.getBoundingClientRect = () => fakeRect(100, 50, 60, 40);
    nav.appendChild(link);
    document.body.appendChild(nav);
    planted.push(nav);

    act(() => {
      vi.advanceTimersByTime(TOUR_TARGET_TIMEOUT_MS - 1);
    });

    // 3px each side: left 100-3, top 50-3, width 60+6, height 40+6.
    const ring = screen.getByTestId("tour-ring");
    expect(ring.style.left).toBe("97px");
    expect(ring.style.top).toBe("47px");
    expect(ring.style.width).toBe("66px");
    expect(ring.style.height).toBe("46px");
  });

  it("holds the tooltip at the toolbar's edge instead of letting it overlap the toolbar", () => {
    // A sticky toolbar 56px tall, and the step's element scrolled up so its top
    // is above the viewport (top -30) - the case where the element is sliding
    // under the toolbar. The card would sit at the cutout's bottom (30px), which
    // is under the toolbar, so it is held down at the toolbar's edge (56px).
    const header = document.createElement("header");
    header.className = "sticky top-0";
    header.getBoundingClientRect = () => fakeRect(0, 0, 1000, 56);
    document.body.appendChild(header);
    planted.push(header);

    plantTarget("card-hero", fakeRect(40, -30, 200, 40));
    renderTour();

    const card = screen.getByRole("dialog");
    expect(card.style.top).toBe("56px");
  });

  it("skips hidden renditions of a selector and rings the visible one", () => {
    // The same selector matches a display:none element (zero rect) first in
    // DOM order - the desktop nav strip on a phone - and a visible one after.
    plantTarget("card-hero", fakeRect(0, 0, 0, 0));
    plantTarget("card-hero", fakeRect(10, 500, 300, 60));
    renderTour();

    const ring = screen.getByTestId("tour-ring");
    expect(ring.style.left).toBe("2px");
    expect(ring.style.top).toBe("492px");
  });

  it("sizes the scrim to the layout viewport, not window.innerWidth, so the hole is not squashed off its element", () => {
    // On desktop window.innerWidth includes the vertical scrollbar but the
    // fixed overlay (and the SVG filling it) does not, so they differ by the
    // scrollbar's width. The SVG uses preserveAspectRatio="none", so if its
    // viewBox carried innerWidth the cutout would be squashed to fit the
    // narrower box and slide left of its element - the toolbar misalignment.
    // The viewBox must carry the layout width (clientWidth) to map 1:1.
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 700,
      configurable: true,
    });
    try {
      plantTarget("card-hero", fakeRect(40, 100, 200, 80));
      renderTour();
      const svg = screen.getByTestId("tour-cutout");
      expect(svg.getAttribute("viewBox")).toBe("0 0 1000 700");
    } finally {
      // Revert to the prototype getter (0 in jsdom) so the other tests keep
      // falling back to window.innerWidth.
      delete (document.documentElement as unknown as { clientWidth?: number })
        .clientWidth;
      delete (document.documentElement as unknown as { clientHeight?: number })
        .clientHeight;
    }
  });

  it("falls back to a centered card, never a blank overlay, when the target never appears", () => {
    renderTour();

    // While it is still looking, the card and a plain scrim are already up.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_STEPS[0].title)).toBeInTheDocument();
    expect(screen.getByTestId("tour-scrim")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(TOUR_TARGET_TIMEOUT_MS);
    });

    // Timed out: still the centered card on a plain scrim, no cutout, no
    // crash.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("tour-scrim")).toBeInTheDocument();
    expect(screen.queryByTestId("tour-cutout")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tour-ring")).not.toBeInTheDocument();
  });

  it("anchors late when the target shows up before the timeout", () => {
    renderTour();
    expect(screen.queryByTestId("tour-cutout")).not.toBeInTheDocument();

    plantTarget("card-hero", fakeRect(40, 100, 200, 80));
    // The MutationObserver would catch the insertion in a real browser; under
    // fake timers the backup poll is the deterministic path.
    act(() => {
      vi.advanceTimersByTime(TOUR_TARGET_TIMEOUT_MS - 1);
    });

    expect(screen.getByTestId("tour-cutout")).toBeInTheDocument();
    expect(screen.getByTestId("tour-ring")).toBeInTheDocument();
  });
});

describe("SpotlightTour - controls", () => {
  it("advances with Next and ends with Done", () => {
    renderTour();

    expect(screen.getByText(HOMEOWNER_STEPS[0].title)).toBeInTheDocument();
    for (let i = 1; i < HOMEOWNER_STEPS.length; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText(HOMEOWNER_STEPS[i].title)).toBeInTheDocument();
    }

    // The last step's primary button is Done, and it ends the tour with the
    // caller's close (which is what stamps the guide seen).
    expect(
      screen.queryByRole("button", { name: "Next" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ends the tour from Skip tour on any step", () => {
    renderTour();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ends the tour on Escape", () => {
    renderTour();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SpotlightTour - navigation", () => {
  it("brings the user to the step's page, announcing the push first", () => {
    // Opened away from the first step's page (a replay from the help page).
    mockPathname = "/account/help";
    renderTour();

    expect(onTourNavigate).toHaveBeenCalledWith(HOMEOWNER_STEPS[0].route);
    expect(mockPush).toHaveBeenCalledWith(HOMEOWNER_STEPS[0].route);
    // The announcement must land before the push, so the caller never reads
    // the tour's own navigation as the user leaving.
    expect(onTourNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      mockPush.mock.invocationCallOrder[0]
    );
  });

  it("does not navigate when the step's page is already up", () => {
    renderTour();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("spotlightPath - the cutout math", () => {
  it("cuts a rounded hole exactly around the rect, evenodd style", () => {
    const d = spotlightPath(1000, 800, {
      top: 100,
      left: 40,
      width: 200,
      height: 80,
    });
    // Outer ring: the whole viewport.
    expect(d.startsWith("M0 0H1000V800H0Z")).toBe(true);
    // Inner ring: starts at the hole's top edge, 12px corner radius in from
    // the left, and spans to the far edge (left 40 + width 200).
    expect(d).toContain("M52 100");
    expect(d).toContain("H228");
    expect(d).toContain("V168");
  });

  it("shrinks the corner radius for a hole too small to hold it", () => {
    const d = spotlightPath(1000, 800, {
      top: 10,
      left: 10,
      width: 10,
      height: 40,
    });
    // Radius clamps to half the smaller side (5), so the arc command carries
    // 5, not 12.
    expect(d).toContain("A5 5 0 0 1");
  });
});
