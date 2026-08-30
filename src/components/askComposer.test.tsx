// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { askLockKey, askResetAt, writeAskLock } from "@/lib/askLock";

// Two owner reports, one component.
//
// 1. "on iPhone, when I type, can you make it like an iMessage where I can
//    fully see what I'm typing." Below sm the composer is an auto-growing
//    <textarea>: Return adds a line and only Send sends, so a long question is
//    written and read before it goes. Desktop keeps the single-line <input>,
//    where Enter still submits the form. That is the whole Enter/Return
//    difference: it is a different ELEMENT per breakpoint, not a key handler,
//    because a browser only submits a form from Enter in an <input>.
//
// 2. "when you use up all tokens for Ask Hearth, click out and go back in, it
//    has the text prompt again... can we just lock it." The lock is written to
//    localStorage with the end of the server's 24 hour window, so a remount
//    inside that window comes back locked, and one after it does not.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
  }),
}));

vi.mock("@/lib/ask-actions", () => ({
  logIssueFromChat: vi.fn(),
  setReminderFromChat: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import AskHearth from "./AskHearth";

// Both keys, per askPhotoGate.test.tsx: the bare one is what the chat reads on
// the very first render, the namespaced one is where it settles once the
// mocked getUser resolves.
function seedLock(limit: number, now = Date.now()) {
  writeAskLock(askLockKey("hearth_ask_chat", "user-1"), limit, now);
  writeAskLock(askLockKey("hearth_ask_chat", null), limit, now);
}

// Let the user-resolving effect (and the storage re-read it triggers) run.
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function phoneWidth(matches: boolean) {
  window.matchMedia = ((q: string) => ({
    media: q,
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  phoneWidth(false);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the composer, by breakpoint", () => {
  it("is a single-line input on desktop, where Enter sends", async () => {
    render(<AskHearth fill />);
    await settle();
    const field = screen.getByPlaceholderText("Ask anything");
    expect(field.tagName).toBe("INPUT");
    // One field, never two: nothing is rendered twice and hidden with CSS.
    expect(screen.getAllByPlaceholderText("Ask anything")).toHaveLength(1);
  });

  it("is a textarea on a phone, where Return adds a line and only Send sends", async () => {
    phoneWidth(true);
    render(<AskHearth fill />);
    await settle();
    const field = screen.getByPlaceholderText("Ask anything");
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveAttribute("rows", "1");
    // 16px on a phone (.input is text-base below sm) or iOS zooms the page on
    // focus, which was half the reported bug.
    expect(field.className).toContain("input");
    expect(field.className).toContain("resize-none");
    expect(screen.getAllByPlaceholderText("Ask anything")).toHaveLength(1);
  });
});

describe("a spent daily allowance", () => {
  it("comes back locked after leaving the screen and returning", async () => {
    seedLock(3);
    const first = render(<AskHearth fill />);
    await settle();
    expect(
      screen.getByText("That's your 3 free questions for today. They reset tomorrow.")
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask anything")).not.toBeInTheDocument();

    // Leave and come back: this is the exact trip that used to hand back an
    // open composer that refused everything typed into it.
    first.unmount();
    render(<AskHearth fill />);
    await settle();
    expect(
      screen.getByText("That's your 3 free questions for today. They reset tomorrow.")
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask anything")).not.toBeInTheDocument();
  });

  it("is open again once the day has rolled over", async () => {
    // Written just before a window boundary, read just after it.
    const now = askResetAt(Date.now()) - 1000;
    seedLock(3, now);
    vi.spyOn(Date, "now").mockReturnValue(askResetAt(now) + 1000);

    render(<AskHearth fill />);
    await settle();
    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
    expect(
      screen.queryByText(/That's your 3 free questions for today/)
    ).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("never locks the pro copilot off the homeowner's spent day", async () => {
    seedLock(3);
    render(
      <AskHearth
        fill
        endpoint="/api/pro-ask"
        storageKeyBase="hearth_pro_ask_chat"
        retentionKeyBase="hearth_pro_ask_retention"
      />
    );
    await settle();
    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
  });
});
