// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The component reads the current route to skip pages the guide must never
// take over (onboarding, /plus, /emergency).
let mockPathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
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
import { APP_GUIDE_EVENT } from "@/lib/appGuide";

const HOMEOWNER_TITLES = [
  "Hearth watches your home",
  "This month",
  "Ask Hearth, real answers",
  "Find a pro when you need one",
];

const PRO_TITLES = [
  "Leads from real homeowners in Orange County",
  "Your profile and reviews",
  "Clients and follow-ups",
  "Ask Hearth for pros",
];

function next() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

// CR2#6: the guide now waits for the real content behind it (the health
// score / first lead) to be on screen AND for GUIDE_OPEN_DELAY_MS to pass
// before it opens. These helpers put that target in the DOM up front (the
// "already there" fast path - see guideTargetPresent in AppGuide.tsx) and
// advance past the delay, so every test below that expects an immediate open
// still gets one, exactly as it did before that change.
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
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AppGuide - homeowner", () => {
  it("opens on a first sign-in and walks four slides, ending on Got it", () => {
    renderHomeownerGuide();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_TITLES[0])).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 4")).toBeInTheDocument();

    next();
    expect(screen.getByText(HOMEOWNER_TITLES[1])).toBeInTheDocument();
    next();
    expect(screen.getByText(HOMEOWNER_TITLES[2])).toBeInTheDocument();
    next();
    expect(screen.getByText(HOMEOWNER_TITLES[3])).toBeInTheDocument();
    expect(screen.getByText("Step 4 of 4")).toBeInTheDocument();

    // Last slide: the button becomes "Got it" and there is no "Next" left.
    expect(
      screen.queryByRole("button", { name: "Next" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).toHaveBeenCalledWith("homeowner");
  });

  it("says all of Orange County, not one city", () => {
    renderHomeownerGuide();
    next();
    next();
    expect(
      screen.getByText(/real local pros across all of Orange County/)
    ).toBeInTheDocument();
  });

  // Two claims the copy is not allowed to make, because the code does not
  // back either one. Asserted rather than trusted: this is the copy somebody
  // reads once, in their first minute, and a promise made here is the one
  // they remember.
  it("does not promise a human on our team", () => {
    renderHomeownerGuide();
    next();
    next();
    // Hearth does not staff human answers. The people in this product are the
    // pros, and the way to reach one is to post a job.
    expect(screen.queryByText(/person on our team/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Hearth answers from your own systems/)
    ).toBeInTheDocument();
  });

  it("states the real review rule: hired through Hearth, one per job", () => {
    renderHomeownerGuide();
    next();
    next();
    next();
    // leave_review() (migration 0132 part 6) deliberately has NO completion
    // requirement - only the pro can close a job, so gating on it would let
    // the reviewed party veto their own reviews.
    expect(
      screen.getByText(
        "Reviews only come from homeowners who hired a pro through Hearth, one per job."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/finished through Hearth/i)).not.toBeInTheDocument();
  });

  it("closes on Skip, stamps the account, and remembers in this browser", () => {
    renderHomeownerGuide();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).toHaveBeenCalledTimes(1);
    expect(markGuideSeenAction).toHaveBeenCalledWith("homeowner");
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBe("1");
  });

  it("closes on Escape", () => {
    renderHomeownerGuide();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).toHaveBeenCalledWith("homeowner");
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
  // was found: it covered the post-a-job form and the walkthrough for anybody
  // who tried to use the app instead of reading it. Navigating past it is a
  // "not now" - closed for this tab, and deliberately NOT stamped as seen.
  it("snoozes for the session when they navigate past it, without stamping it seen", () => {
    const { rerender } = renderHomeownerGuide();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // They ignore the sheet and tap into the app.
    mockPathname = "/contractors";
    rerenderHomeownerGuide(rerender);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markGuideSeenAction).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("hearth_app_guide_seen")).toBeNull();
    expect(window.sessionStorage.getItem("hearth_app_guide_snoozed")).toBe("1");

    // And it does not come back on the next page either.
    mockPathname = "/walkthrough";
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

    fireEvent(window, new CustomEvent(APP_GUIDE_EVENT));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the snooze on the side it happened on", () => {
    const { rerender } = renderHomeownerGuide();
    mockPathname = "/contractors";
    rerenderHomeownerGuide(rerender);
    expect(window.sessionStorage.getItem("hearth_app_guide_snoozed")).toBe("1");
    // One account can hold both sides; waving away the homeowner guide must
    // not eat the pro one.
    expect(
      window.sessionStorage.getItem("hearth_pro_guide_snoozed")
    ).toBeNull();
  });

  it("reopens on demand from the help page, even after it was seen", () => {
    // Also bypasses the delay - see the note above.
    render(<AppGuide side="homeowner" startOpen={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent(window, new CustomEvent(APP_GUIDE_EVENT));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_TITLES[0])).toBeInTheDocument();
  });

  it("swipes forward and back between slides", () => {
    renderHomeownerGuide();
    const dialog = screen.getByRole("dialog");

    fireEvent.pointerDown(dialog, { clientX: 240, clientY: 300 });
    fireEvent.pointerUp(dialog, { clientX: 60, clientY: 310 });
    expect(screen.getByText(HOMEOWNER_TITLES[1])).toBeInTheDocument();

    fireEvent.pointerDown(dialog, { clientX: 60, clientY: 300 });
    fireEvent.pointerUp(dialog, { clientX: 240, clientY: 310 });
    expect(screen.getByText(HOMEOWNER_TITLES[0])).toBeInTheDocument();

    // A short drag is a tap, not a swipe.
    fireEvent.pointerDown(dialog, { clientX: 240, clientY: 300 });
    fireEvent.pointerUp(dialog, { clientX: 225, clientY: 302 });
    expect(screen.getByText(HOMEOWNER_TITLES[0])).toBeInTheDocument();
  });

  it("does not close by swiping off the end of the last slide", () => {
    renderHomeownerGuide();
    next();
    next();
    next();
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(dialog, { clientX: 240, clientY: 300 });
    fireEvent.pointerUp(dialog, { clientX: 60, clientY: 310 });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_TITLES[3])).toBeInTheDocument();
    expect(markGuideSeenAction).not.toHaveBeenCalled();
  });
});

describe("AppGuide - contractor", () => {
  it("shows the pro slides, not the homeowner ones", () => {
    mockPathname = "/pro";
    renderProGuide();

    expect(screen.getByText(PRO_TITLES[0])).toBeInTheDocument();
    expect(screen.queryByText(HOMEOWNER_TITLES[0])).not.toBeInTheDocument();

    next();
    expect(screen.getByText(PRO_TITLES[1])).toBeInTheDocument();
    // Same two claims, pro side. The license line has to describe the check
    // that actually runs (src/lib/cslb.ts + the weekly recheck cron), and the
    // review line has to say "hired", never "finished".
    expect(
      screen.getByText(/checks it against the state board/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Reviews only come from homeowners who hired you through Hearth, one per job/
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/jobs you finished/i)).not.toBeInTheDocument();
    next();
    expect(screen.getByText(PRO_TITLES[2])).toBeInTheDocument();
    next();
    expect(screen.getByText(PRO_TITLES[3])).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
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
