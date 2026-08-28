// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Ask Hearth streams its answer: the route sends NDJSON (see
// src/lib/askStream.ts) and the chat fills one bubble in as the lines arrive.
// This file covers the part unit tests can't: that a stream of deltas ends up
// as ONE assistant message with the whole answer in it, that a half-written
// machine-readable block never shows through, and that the buttons those
// blocks produce wait for the end of the answer.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// The chat resolves the signed-in user to namespace its localStorage key.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
  }),
}));

// "use server" module (Supabase + next/cache); the chat only calls these from
// a button nothing in this file taps.
vi.mock("@/lib/ask-actions", () => ({
  logIssueFromChat: vi.fn(),
  setReminderFromChat: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import AskHearth from "./AskHearth";

// A response body the test feeds by hand, one push at a time, so assertions
// can land mid-answer.
function makeStream() {
  const queue: (string | "end")[] = [];
  let notify: (() => void) | null = null;
  const encoder = new TextEncoder();

  const push = (line: string | "end") => {
    queue.push(line);
    notify?.();
    notify = null;
  };

  const reader = {
    async read() {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => (notify = resolve));
      }
      const item = queue.shift() as string | "end";
      return item === "end"
        ? { done: true, value: undefined }
        : { done: false, value: encoder.encode(item) };
    },
    async cancel() {},
  };

  const response = {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type"
          ? "application/x-ndjson; charset=utf-8"
          : null,
    },
    body: { getReader: () => reader },
    json: async () => {
      throw new Error("a streamed reply has no JSON body");
    },
  };

  return { push, response };
}

const delta = (text: string) => `${JSON.stringify({ delta: text })}\n`;
const done = (payload: Record<string, unknown>) =>
  `${JSON.stringify({ done: true, ...payload })}\n`;

// Let the pending reads, the 60ms repaint throttle, and the state updates they
// queue all settle, inside act() so React does not complain.
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
}

async function ask(question: string) {
  const input = await screen.findByPlaceholderText("Ask anything");
  fireEvent.change(input, { target: { value: question } });
  const send = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(send).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(send);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no layout, so this is a no-op stub rather than a real scroll.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a streamed answer", () => {
  it("lands as ONE assistant bubble holding the whole answer", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("Why is my water heater loud?");

    // The question is on screen, once, while the answer is still coming.
    expect(screen.getAllByText("Why is my water heater loud?")).toHaveLength(1);

    stream.push(delta("Sediment in the tank. "));
    await settle();
    expect(screen.getByText(/Sediment in the tank\./)).toBeInTheDocument();

    stream.push(delta("Flushing it usually fixes the noise."));
    stream.push(
      done({
        answer: "Sediment in the tank. Flushing it usually fixes the noise.",
        freeRemaining: 2,
        freeLimit: 3,
      })
    );
    await settle();

    // ONE bubble with the finished text, not one per delta and not a second
    // copy appended at the end.
    expect(
      screen.getAllByText(
        "Sediment in the tank. Flushing it usually fixes the noise."
      )
    ).toHaveLength(1);
    // The half-written first delta is gone, replaced in place rather than
    // stacked above the finished answer.
    expect(screen.queryByText("Sediment in the tank.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Why is my water heater loud?")).toHaveLength(1);
    // The free-tier meter from the terminal line.
    expect(screen.getByText("2 of 3 free questions left today")).toBeInTheDocument();
  });

  it("hides a half-written machine block, and holds its buttons until the end", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("Should I call someone?");

    // Mid-stream: the OPTIONS block has opened and its JSON is incomplete.
    stream.push(delta("Probably worth a look.\n\n[[OPTIONS]]{\"options\":[\"Yes"));
    await settle();

    expect(screen.getByText(/Probably worth a look\./)).toBeInTheDocument();
    // None of the raw block leaks into the bubble...
    expect(screen.queryByText(/OPTIONS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[\[/)).not.toBeInTheDocument();
    // ...and no quick-reply button appears off a block that isn't finished.
    expect(
      screen.queryByRole("button", { name: "Yes" })
    ).not.toBeInTheDocument();

    stream.push(
      done({
        answer:
          'Probably worth a look.\n\n[[OPTIONS]]{"options":["Yes","No"]}[[/OPTIONS]]',
      })
    );
    await settle();

    // Now that the answer has finished, the buttons show.
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No" })).toBeInTheDocument();
    expect(screen.queryByText(/OPTIONS/)).not.toBeInTheDocument();
  });

  // Markdown caught mid-token: "**Getting ready for winter" has no closing
  // "**" yet, and the renderer needs both halves to match - so the raw
  // asterisks were sitting on screen for as long as the rest of the line took
  // to arrive. The growing bubble goes through the same renderer as a finished
  // reply, told the text is still partial.
  it("renders bold as bold while the answer is still streaming, never as asterisks", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("How do I get ready for winter?");

    // The closing "**" has not arrived yet.
    stream.push(delta("**Getting ready for winter"));
    await settle();

    expect(document.querySelector("strong")?.textContent).toBe(
      "Getting ready for winter"
    );
    expect(document.body.textContent).not.toContain("**");

    // The rest of the line lands: still one bold heading, still no asterisks.
    stream.push(delta("**\n\n- Drain the hose bibs."));
    await settle();

    expect(document.querySelector("strong")?.textContent).toBe(
      "Getting ready for winter"
    );
    expect(document.body.textContent).not.toContain("**");

    stream.push(
      done({
        answer: "**Getting ready for winter**\n\n- Drain the hose bibs.",
      })
    );
    await settle();

    expect(document.querySelector("strong")?.textContent).toBe(
      "Getting ready for winter"
    );
    expect(screen.getByText("Drain the hose bibs.")).toBeInTheDocument();
  });

  it("keeps the text that arrived when the connection drops mid-answer, and persists it as a partial answer", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("What is that noise?");

    stream.push(delta("It is probably the expansion tank."));
    // The body ends with no terminal line: the connection died.
    stream.push("end");
    await settle();

    // Half an answer the reader has already started reading beats replacing
    // it with an apology.
    expect(
      screen.getByText("It is probably the expansion tank.")
    ).toBeInTheDocument();

    // Persisted once, marked partial, so a reload shows this answer instead
    // of an orphaned question with "That took too long. Try asking again."
    const stored = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    const last = stored[stored.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("It is probably the expansion tank.");
    expect(last.partial).toBe(true);
  });

  it("says so plainly when the connection drops before a single word, without persisting the apology", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("Anything there?");

    stream.push("end");
    await settle();

    expect(
      screen.getByText("Something went wrong, try again.")
    ).toBeInTheDocument();
    // Nothing arrived worth keeping, so the question goes back in the
    // composer for a one-tap retry.
    expect(screen.getByPlaceholderText("Ask anything")).toHaveValue(
      "Anything there?"
    );

    // The apology itself is NOT saved: the user's question stays the newest
    // persisted message, so a reload still treats this as unanswered
    // (Retry / Delete) instead of showing a saved apology as a real answer.
    const stored = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    expect(stored[stored.length - 1]).toMatchObject({
      role: "user",
      content: "Anything there?",
    });
  });
});

describe("a non-streamed reply still works", () => {
  it("renders a plain JSON refusal exactly as it always did", async () => {
    // Every pre-model gate (out of questions, photo locked, rate limited) is
    // still an ordinary JSON body, and the client branches on content type.
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
    await ask("Look at this");
    await settle();

    expect(
      screen.getByText("Photo questions are part of Hearth Plus.")
    ).toBeInTheDocument();
    // A locked request never reached the model, so the question is handed back.
    expect(screen.getByPlaceholderText("Ask anything")).toHaveValue(
      "Look at this"
    );
  });
});
