// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The component reads the current route to skip pages the guide must never
// take over (onboarding, /plus, /emergency), and the tour inside it navigates
// between the pages its steps talk about.
let mockPathname = "/dashboard";
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}));

// The server action is a real network round trip in the app. Here it only has
// to record that closing the guide asked for the account to be stamped.
const markGuideSeenAction = vi.fn(async (_side: string) => {});
vi.mock("@/lib/appGuideActions", () => ({
  markGuideSeenAction: (side: string) => markGuideSeenAction(side),
}));

import AppGuide, {
  GUIDE_OPEN_DELAY_MS,
  GUIDE_TARGET_TIMEOUT_MS,
} from "./AppGuide";
import { HOMEOWNER_STEPS, PRO_STEPS } from "./SpotlightTour";
import { APP_GUIDE_EVENT } from "@/lib/appGuide";

// This file tests the GATE: when the guide opens, snoozes, replays, and
// stamps itself seen. The tour's own mechanics (the cutout, the target wait,
// the card placement) live in SpotlightTour.test.tsx. None of the tests here
// put the steps' target elements in the DOM, so every step below renders as
// the tour's centered fallback card - which is exactly the "never a blank
// overlay, never a crash" contract holding up under a bare test DOM.

function next() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

// CR2#6: the guide waits for the real content behind it (the health score /
// first lead) to be on screen AND for GUIDE_OPEN_DELAY_MS to pass before it
// opens. These helpers put that target in the DOM up front (the "already
// there" fast path - see guideTargetPresent in AppGuide.tsx) and advance past
// the delay, so every test below that expects an immediate open gets one.
function renderHomeownerGuide(props: Partial<{ startOpen: boolean }> = {}) {
  const result = render(
    <>
      <div id="this-month" />
      <AppGuide side="homeowner" startOpen {...props} />
    </>
  );
  act(() => {
    vi.advanceTimersByTime(GUIDE_OPEN_DELAY_MS);
  });
  return result;
}

function rerenderHomeownerGuide(
  rerender: ReturnType<typeof render>["rerender"],
  props: Partial<{ startOpen: boolean }> = {}
) {
  rerender(
    <>
      <div id="this-month" />
      <AppGuide side="homeowner" startOpen {...props} />
    </>
  );
}

function renderProGuide(props: Partial<{ startOpen: boolean }> = {}) {
  const result = render(
    <>
      <p className="stat-label">Open jobs</p>
      <AppGuide side="pro" startOpen {...props} />
    </>
  );
  act(() => {
    vi.advanceTimersByTime(GUIDE_OPEN_DELAY_MS);
  });
  return result;
}

beforeEach(() => {
  mockPathname = "/dashboard";
  markGuideSeenAction.mockClear();
  mockPush.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AppGuide - homeowner", () => {
  it("opens on a first sign-in and walks every step, ending on Done", () => {
    renderHomeownerGuide();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_STEPS[0].title)).toBeInTheDocument();
    expect(
      screen.getByText(`Step 1 of ${HOMEOWNER_STEPS.length}`)
    ).toBeInTheDocument();

    for (let i = 1; i < HOMEOWNER_STEPS.length; i++) {
      next();
      expect(screen.getByText(HOMEOWNER_STEPS[i].title)).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        `Step ${HOMEOWNER_STEPS.length} of ${HOMEOWNER_STEPS.length}`
      )
    ).toBeInTheDocument();

    // Last step: the button becomes "Done" and there is no "Next" left.
    expect(
      screen.queryByRole("button", { name: "Next" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).toHaveBeenCalledWith("homeowner");
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBe("1");
  });

  it("stays on the dashboard for every homeowner step, so the tour never yanks a first-timer around", () => {
    // Every homeowner step lives on /dashboard, where the guide auto-opens,
    // so the tour should not have to push a single navigation.
    renderHomeownerGuide();
    for (let i = 1; i < HOMEOWNER_STEPS.length; i++) next();
    expect(mockPush).not.toHaveBeenCalled();
  });

  // A claim the copy is not allowed to make, because the code does not back
  // it: Hearth does not staff human answers. The people in this product are
  // the pros, and the way to reach one is to post a job.
  it("does not promise a human on our team", () => {
    renderHomeownerGuide();
    next();
    next();
    next();
    expect(screen.queryByText(/person on our team/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/answers from your own systems/)
    ).toBeInTheDocument();
  });

  it("closes on Skip tour, stamps the account, and remembers in this browser", () => {
    renderHomeownerGuide();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).toHaveBeenCalledTimes(1);
    expect(markGuideSeenAction).toHaveBeenCalledWith("homeowner");
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBe("1");
  });

  it("closes on Escape, with the same finality as Skip tour", () => {
    renderHomeownerGuide();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).toHaveBeenCalledWith("homeowner");
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBe("1");
  });

  it("stays shut for an account that has already been through it", () => {
    render(
      <>
        <div id="this-month" />
        <AppGuide side="homeowner" startOpen={false} />
      </>
    );
    act(() => {
      vi.advanceTimersByTime(GUIDE_TARGET_TIMEOUT_MS);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays shut when this browser already saw it, even if the stamp has not landed", () => {
    window.localStorage.setItem("hearth_app_guide_seen", "1");
    render(
      <>
        <div id="this-month" />
        <AppGuide side="homeowner" startOpen />
      </>
    );
    act(() => {
      vi.advanceTimersByTime(GUIDE_TARGET_TIMEOUT_MS);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never takes over onboarding or a payment screen", () => {
    mockPathname = "/plus";
    render(
      <>
        <div id="this-month" />
        <AppGuide side="homeowner" startOpen />
      </>
    );
    act(() => {
      vi.advanceTimersByTime(GUIDE_TARGET_TIMEOUT_MS);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // The guide used to re-open, full screen, on EVERY route change until Skip
  // was found. Navigating past it is a "not now" - closed for this tab, and
  // deliberately NOT stamped as seen. With the tour navigating between pages
  // itself, this doubles as the "unmounts cleanly on an external route
  // change" contract: only a navigation the tour did not push counts.
  it("snoozes for the session when they navigate past it, without stamping it seen", () => {
    const { rerender } = renderHomeownerGuide();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // They ignore the tour and tap into the app (or press back).
    mockPathname = "/walkthrough";
    rerenderHomeownerGuide(rerender);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBeNull();
    expect(window.sessionStorage.getItem("hearth_app_guide_snoozed")).toBe("1");

    // And it does not come back on the next page either.
    mockPathname = "/contractors";
    rerenderHomeownerGuide(rerender);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays shut for the rest of a session that already snoozed it", () => {
    window.sessionStorage.setItem("hearth_app_guide_snoozed", "1");
    render(
      <>
        <div id="this-month" />
        <AppGuide side="homeowner" startOpen />
      </>
    );
    act(() => {
      vi.advanceTimersByTime(GUIDE_TARGET_TIMEOUT_MS);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still replays from the help page after a snooze", () => {
    // The snooze is not "seen": the help link is exactly how somebody who
    // waved it away gets it back. The replay path bypasses the delay
    // entirely (see the onShow effect in AppGuide.tsx), so no target/timer
    // wait is needed here.
    window.sessionStorage.setItem("hearth_app_guide_snoozed", "1");
    render(<AppGuide side="homeowner" startOpen />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      fireEvent(window, new CustomEvent(APP_GUIDE_EVENT));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the snooze on the side it happened on", () => {
    const { rerender } = renderHomeownerGuide();
    mockPathname = "/walkthrough";
    rerenderHomeownerGuide(rerender);
    expect(window.sessionStorage.getItem("hearth_app_guide_snoozed")).toBe("1");
    // One account can hold both sides; waving away the homeowner guide must
    // not eat the pro one.
    expect(
      window.sessionStorage.getItem("hearth_pro_guide_snoozed")
    ).toBeNull();
  });

  it("reopens on demand from the help page, restarting from the first step, even after it was seen", () => {
    // Also bypasses the delay - see the note above. Replaying from the help
    // page means the tour opens away from /dashboard, so its first step
    // brings the user there itself - and that push must NOT count as
    // "navigated past it".
    mockPathname = "/account/help";
    const { rerender } = render(<AppGuide side="homeowner" startOpen={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      fireEvent(window, new CustomEvent(APP_GUIDE_EVENT));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_STEPS[0].title)).toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith(HOMEOWNER_STEPS[0].route);

    // The tour's own navigation lands: still open, and NOT snoozed - only a
    // navigation the tour did not push counts as leaving.
    mockPathname = HOMEOWNER_STEPS[0].route;
    rerender(<AppGuide side="homeowner" startOpen={false} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem("hearth_app_guide_snoozed")
    ).toBeNull();
  });
});

describe("AppGuide - contractor", () => {
  it("shows the pro steps, not the homeowner ones", () => {
    mockPathname = "/pro";
    renderProGuide();

    expect(screen.getByText(PRO_STEPS[0].title)).toBeInTheDocument();
    expect(
      screen.queryByText(HOMEOWNER_STEPS[0].title)
    ).not.toBeInTheDocument();

    for (let i = 1; i < PRO_STEPS.length; i++) {
      next();
      expect(screen.getByText(PRO_STEPS[i].title)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(markGuideSeenAction).toHaveBeenCalledWith("pro");
    // The pro side has its own key, so a pro who also owns a home still gets
    // the homeowner guide on that side.
    expect(window.localStorage.getItem("hearth_pro_guide_seen")).toBe("1");
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBeNull();
  });

  it("stays out of the pro setup flow", () => {
    mockPathname = "/pro/onboarding";
    render(
      <>
        <p className="stat-label">Open jobs</p>
        <AppGuide side="pro" startOpen />
      </>
    );
    act(() => {
      vi.advanceTimersByTime(GUIDE_TARGET_TIMEOUT_MS);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// CR2#6: the delay itself, isolated from every other behavior above.
describe("AppGuide - delayed first open", () => {
  it("waits out the minimum delay even with the target already on screen", () => {
    render(
      <>
        <div id="this-month" />
        <AppGuide side="homeowner" startOpen />
      </>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(GUIDE_OPEN_DELAY_MS - 1);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("falls back to opening on the timer alone when the target never renders", () => {
    // No #this-month anywhere in the DOM - a page the target selector does
    // not describe, or a future redesign that dropped it.
    render(<AppGuide side="homeowner" startOpen />);

    act(() => {
      vi.advanceTimersByTime(GUIDE_TARGET_TIMEOUT_MS - 1);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("still opens for a pro once the Open jobs tile is on screen", () => {
    mockPathname = "/pro";
    render(
      <>
        <p className="stat-label">Open jobs</p>
        <AppGuide side="pro" startOpen />
      </>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(GUIDE_OPEN_DELAY_MS);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
