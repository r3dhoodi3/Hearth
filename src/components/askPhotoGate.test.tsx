// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The fairness fix: a free homeowner should learn a photo needs Hearth Plus
// from the attach button itself, before they tap it - never after they've
// already picked a photo and sent it. See AskHearth's `photoGate` (driven by
// the remembered plan, `hearth_ask_plan[:<uid>]` in localStorage) and the
// button/label split in the composer.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// The chat resolves the signed-in user to namespace its localStorage key
// (here, the plan key the gate reads).
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

const PLAN_KEY = "hearth_ask_plan:user-1";

function rememberedPlan(plan: "free" | "trial" | "plus") {
  // Seed both the per-user key (what the component settles on once the
  // mocked user resolves) and the bare legacy key (what it reads on the
  // very first render, before that), so the gate is already in its final
  // state by the time a test's first assertion runs.
  window.localStorage.setItem(PLAN_KEY, plan);
  window.localStorage.setItem("hearth_ask_plan", plan);
}

async function attachControl() {
  await screen.findByPlaceholderText("Ask anything");
  // Give the plan-read effect (gated on the mocked async getUser()) a turn
  // to run before asking what the composer looks like.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the photo-attach control on a free plan", () => {
  it("shows a Plus tag and never opens the picker", async () => {
    rememberedPlan("free");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<AskHearth fill />);
    await attachControl();

    const btn = await screen.findByRole("button", {
      name: "Attach a photo, requires Hearth Plus",
    });
    // The visible tag, matching the dashboard's Plus chip.
    expect(within(btn).getByText("Plus")).toBeInTheDocument();
    // No real file input backs this control - there is nothing to open.
    expect(document.querySelector('input[type="file"]')).toBeNull();

    fireEvent.click(btn);

    // The same gentle lock message the server's own refusal shows, reached
    // without ever having attached anything.
    expect(
      await screen.findByText("Photos need Hearth Plus.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "See what Hearth Plus adds" })
    ).toHaveAttribute("href", "/plus?reason=ask");

    // No photo was ever picked, and no request went out: tapping the
    // button did no work that would only be refused afterward.
    expect(screen.queryByAltText("attachment preview")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the photo-attach control on a Plus plan", () => {
  it("opens the picker as before, with no Plus tag", async () => {
    rememberedPlan("plus");

    render(<AskHearth fill />);
    await attachControl();

    await waitFor(() => {
      expect(screen.getByTitle("Attach a photo")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /Attach a photo/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Plus")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();

    fireEvent.click(screen.getByTitle("Attach a photo"));
    expect(screen.queryByText("Photos need Hearth Plus.")).not.toBeInTheDocument();
  });
});

describe("the photo-attach control on an unknown plan", () => {
  it("opens the picker rather than risk blocking a member", async () => {
    // Nothing remembered: a brand-new device/tab, first turn.
    render(<AskHearth fill />);
    await attachControl();

    await waitFor(() => {
      expect(screen.getByTitle("Attach a photo")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /Attach a photo/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Plus")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe("the photo-attach control on a trial plan", () => {
  it("opens the picker like Plus, since a trial keeps photos", async () => {
    // A Plus trial member gets photos (that is what the trial is for), so
    // only "free" should ever gate the button. See askTier in
    // src/app/api/ask/route.ts and the rememberPlan call in applyAllowance.
    rememberedPlan("trial");

    render(<AskHearth fill />);
    await attachControl();

    await waitFor(() => {
      expect(screen.getByTitle("Attach a photo")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /Attach a photo/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Plus")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe("the free-allowance hint under an empty composer", () => {
  // No number on the Plus side on purpose: naming the ceiling made the upgrade
  // read as a cap rather than a lift, and the copy must not go stale when the
  // limit moves. The free "3" stays, since that is the one being spent.
  const hint = "3 free questions a day. Plus gives you more, plus photo answers.";

  it("shows for a remembered free plan", async () => {
    rememberedPlan("free");
    render(<AskHearth fill />);
    await attachControl();
    expect(await screen.findByText(hint)).toBeInTheDocument();
  });

  it("stays hidden for a remembered trial plan", async () => {
    // A trial member is already on the full Plus allowance and has photos, so
    // a pitch for Plus does not belong under their composer.
    rememberedPlan("trial");
    render(<AskHearth fill />);
    await attachControl();
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
  });
});

describe("askTier tells a trial member apart from a free one", () => {
  it("stores trial, shows the trial meter, and leaves photos open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        body: null,
        json: async () => ({
          answer: "Sure, here's what I'd check.",
          freeRemaining: 5,
          freeLimit: 8,
          askTier: "trialing",
        }),
      }))
    );

    render(<AskHearth fill />);
    const input = await screen.findByPlaceholderText("Ask anything");
    fireEvent.change(input, { target: { value: "What's this noise?" } });
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(send);
    });

    await screen.findByText("Sure, here's what I'd check.");

    expect(window.localStorage.getItem(PLAN_KEY)).toBe("trial");
    expect(
      screen.getByText("5 of 8 questions left today on your trial")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "3 free questions a day. Plus gives you more, plus photo answers."
      )
    ).not.toBeInTheDocument();
    // A trial member keeps photos: the picker, not the Plus-gated button.
    expect(screen.getByTitle("Attach a photo")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Attach a photo/i })
    ).not.toBeInTheDocument();
  });

  it("still stores free and gates the photo button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        body: null,
        json: async () => ({
          answer: "Sure, here's what I'd check.",
          freeRemaining: 2,
          freeLimit: 3,
          askTier: "free",
        }),
      }))
    );

    render(<AskHearth fill />);
    const input = await screen.findByPlaceholderText("Ask anything");
    fireEvent.change(input, { target: { value: "What's this noise?" } });
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(send);
    });

    await screen.findByText("Sure, here's what I'd check.");

    expect(window.localStorage.getItem(PLAN_KEY)).toBe("free");
    expect(
      await screen.findByRole("button", {
        name: "Attach a photo, requires Hearth Plus",
      })
    ).toBeInTheDocument();
  });
});

describe("a server photo lock", () => {
  it("remembers the plan as free so the tag shows from then on", async () => {
    // Nothing remembered yet, so the picker opens - this is the ONE time a
    // free homeowner can still reach the server's own refusal.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        body: null,
        json: async () => ({
          answer: "Photo questions are part of Hearth Plus.",
          locked: true,
          link: { href: "/plus?reason=ask", label: "See Hearth Plus" },
        }),
      }))
    );

    render(<AskHearth fill />);
    const input = await screen.findByPlaceholderText("Ask anything");
    fireEvent.change(input, { target: { value: "What's this?" } });
    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(send);
    });

    await screen.findByText("Photo questions are part of Hearth Plus.");

    // The verdict is remembered: a reload of this same chat now gates the
    // button before any further tap.
    expect(window.localStorage.getItem(PLAN_KEY)).toBe("free");
    expect(
      await screen.findByRole("button", {
        name: "Attach a photo, requires Hearth Plus",
      })
    ).toBeInTheDocument();
  });
});
