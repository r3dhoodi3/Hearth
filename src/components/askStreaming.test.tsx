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

// The canned opener the chat starts every conversation with; it is part of the
// saved list, so the order assertions below account for it.
const GREETING =
  "Hi, I'm Hearth. If you have any questions about your home, feel free to ask.";

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

  it("shows a cut-off notice on a partial answer and withholds its actions until asked again", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("Should I call someone?");

    // The OPTIONS block is complete - only the stream itself is cut short.
    stream.push(
      delta(
        'Probably worth a look.\n\n[[OPTIONS]]{"options":["Yes","No"]}[[/OPTIONS]]'
      )
    );
    stream.push("end");
    await settle();

    expect(screen.getByText(/Probably worth a look\./)).toBeInTheDocument();
    expect(
      screen.getByText("This answer was cut off. Ask again for the full one.")
    ).toBeInTheDocument();
    // A partial answer's machine-readable block never turns into tappable
    // actions, even though the JSON itself finished: the reply may still
    // change once it's asked again in full.
    expect(
      screen.queryByRole("button", { name: "Yes" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "No" })
    ).not.toBeInTheDocument();
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

// THE SECOND QUESTION. One finished answer, then another question in the same
// conversation. The reported regression: sending Q2 wiped Q1's answer off the
// transcript and out of localStorage, so a reload came back with two questions,
// no answers, and a "That took too long" orphan card.
describe("a second question in the same conversation", () => {
  it("keeps the first answer on screen and on disk", async () => {
    const first = makeStream();
    const second = makeStream();
    const streams = [first.response, second.response];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streams.shift() ?? second.response)
    );

    render(<AskHearth fill />);
    await ask("Why is my water heater loud?");

    first.push(delta("Sediment in the tank."));
    first.push(done({ answer: "Sediment in the tank." }));
    await settle();

    expect(screen.getByText("Sediment in the tank.")).toBeInTheDocument();

    const storedAfterFirst = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    expect(storedAfterFirst.map((m: any) => m.content)).toEqual([
      GREETING,
      "Why is my water heater loud?",
      "Sediment in the tank.",
    ]);

    // Q2 goes out. Nothing about it touches Q1's answer.
    await ask("How do I flush it?");
    await settle();

    // (a) the first answer is still in the transcript while Q2 is thinking
    expect(screen.getByText("Sediment in the tank.")).toBeInTheDocument();
    expect(screen.getByText("How do I flush it?")).toBeInTheDocument();
    // ...and the unanswered-orphan card is NOT shown: this question is in
    // flight, not abandoned.
    expect(
      screen.queryByText("That took too long. Try asking again.")
    ).not.toBeInTheDocument();

    // (b) localStorage holds Q1 question, Q1 answer, Q2 question
    const midFlight = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    expect(midFlight.map((m: any) => m.content)).toEqual([
      GREETING,
      "Why is my water heater loud?",
      "Sediment in the tank.",
      "How do I flush it?",
    ]);

    second.push(delta("Attach a hose to the drain valve."));
    second.push(done({ answer: "Attach a hose to the drain valve." }));
    await settle();

    // (c) both answers, in order, on screen and on disk
    expect(screen.getByText("Sediment in the tank.")).toBeInTheDocument();
    expect(
      screen.getByText("Attach a hose to the drain valve.")
    ).toBeInTheDocument();

    const stored = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    expect(stored.map((m: any) => [m.role, m.content])).toEqual([
      ["assistant", GREETING],
      ["user", "Why is my water heater loud?"],
      ["assistant", "Sediment in the tank."],
      ["user", "How do I flush it?"],
      ["assistant", "Attach a hose to the drain valve."],
    ]);
  });

  it("rebuilds from the saved conversation when memory has fallen behind", async () => {
    // The reported failure, forced: the in-memory conversation loses the
    // finished answer while the saved one still has it. Whatever leaves the
    // ref behind (a render that ran with older state, a lost race), the next
    // question must not be built on the short list.
    const first = makeStream();
    const second = makeStream();
    const streams = [first.response, second.response];
    const bodies: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        bodies.push(
          JSON.parse(init.body).messages.map((m: any) => m.content as string)
        );
        return streams.shift() ?? second.response;
      })
    );

    render(<AskHearth fill />);
    await ask("Why is my water heater loud?");
    first.push(done({ answer: "Sediment in the tank." }));
    await settle();

    const key = "hearth_ask_chat:user-1";
    const saved = window.localStorage.getItem(key) ?? "[]";
    const withoutAnswer = JSON.parse(saved).filter(
      (m: any) => m.content !== "Sediment in the tank."
    );

    // Push the chat back to the shorter list (this is what a storage re-sync
    // does), then quietly restore the full one on disk without telling it.
    // Memory is now behind disk by exactly one finished answer.
    await act(async () => {
      window.localStorage.setItem(key, JSON.stringify(withoutAnswer));
      window.dispatchEvent(
        new CustomEvent("hearth:ask-updated", { detail: { key } })
      );
    });
    expect(
      screen.queryByText("Sediment in the tank.")
    ).not.toBeInTheDocument();
    window.localStorage.setItem(key, saved);

    await ask("How do I flush it?");
    await settle();

    // The answer is back in the transcript, in the request, and on disk.
    expect(screen.getByText("Sediment in the tank.")).toBeInTheDocument();
    expect(bodies[1]).toEqual([
      "Why is my water heater loud?",
      "Sediment in the tank.",
      "How do I flush it?",
    ]);
    expect(
      JSON.parse(window.localStorage.getItem(key) ?? "[]").map(
        (m: any) => m.content
      )
    ).toEqual([
      GREETING,
      "Why is my water heater loud?",
      "Sediment in the tank.",
      "How do I flush it?",
    ]);
  });
});

// The answer is on screen for as long as it takes to write, and it used to be
// nowhere else until the terminal line landed. Anything that re-read the store
// inside that window - a reload, another instance of this chat on the page -
// found the question with nothing under it.
describe("an answer still being written", () => {
  it("is saved as it grows, so a reload shows it instead of an orphan card", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    const view = render(<AskHearth fill />);
    await ask("What is that noise?");

    stream.push(delta("It is probably the expansion tank."));
    await settle();

    // Mid-answer, with no terminal line yet: what is on screen is on disk.
    const midStream = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    expect(midStream[midStream.length - 1]).toMatchObject({
      role: "assistant",
      content: "It is probably the expansion tank.",
      partial: true,
    });

    // The page goes away mid-answer and comes back.
    view.unmount();
    render(<AskHearth fill />);

    expect(
      await screen.findByText("It is probably the expansion tank.")
    ).toBeInTheDocument();
    // The conversation ends on an answer, so the unanswered-question card has
    // no business here.
    expect(
      screen.queryByText("That took too long. Try asking again.")
    ).not.toBeInTheDocument();
  });
});

// localStorage is a few megabytes and this chat carries base64 photos. A write
// that overflows it THROWS, and the old code swallowed that whole - so the
// short questions fitted and were saved while the long answers between them
// were silently dropped.
describe("a full localStorage", () => {
  it("sheds old history rather than losing the answer that just finished", async () => {
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (value.length > 2000) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      realSetItem.call(this, key, value);
    });

    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    // A long opener stands in for the long history a real chat accumulates:
    // the whole conversation no longer fits, only its newest turns do.
    render(<AskHearth fill greeting={"a lot of history. ".repeat(200)} />);
    await ask("Why is my water heater loud?");

    stream.push(done({ answer: "Sediment in the tank." }));
    await settle();

    const stored = JSON.parse(
      window.localStorage.getItem("hearth_ask_chat:user-1") ?? "[]"
    );
    // The oldest messages were shed to make room; the newest turn - the
    // question AND its answer - is what survives.
    expect(stored.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Why is my water heater loud?"],
      ["assistant", "Sediment in the tank."],
    ]);

    vi.restoreAllMocks();
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

// A CLEARED CONVERSATION MUST STAY CLEARED, even with an answer in flight.
//
// consumeStream captures the transcript as it stood when the question was sent
// and rewrites the reply bubble onto that snapshot every 60ms until the
// terminal line lands. Anything that throws the conversation away in that
// window used to be undone by the next repaint: the cleared turns came back on
// screen AND were written to localStorage again. The chat's own Clear button
// is now locked while an answer streams, so the way in is a SECOND TAB, which
// reaches this tab as a storage event and nothing else.
describe("clearing while an answer is streaming", () => {
  const CHAT_KEY = "hearth_ask_chat:user-1";

  // What another tab's clear looks like from here: removeItem fires a storage
  // event with a null newValue. jsdom does not dispatch these on its own.
  function otherTabCleared(key = CHAT_KEY) {
    window.localStorage.removeItem(key);
    window.dispatchEvent(
      new StorageEvent("storage", { key, oldValue: "[]", newValue: null })
    );
  }

  it("drops an in-flight answer instead of writing the cleared chat back", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("Why is my water heater loud?");

    stream.push(delta("Sediment in the tank. "));
    await settle();
    expect(screen.getByText(/Sediment in the tank\./)).toBeInTheDocument();

    // Another tab clears the conversation mid-answer.
    await act(async () => {
      otherTabCleared();
    });
    await settle();
    expect(
      screen.queryByText("Why is my water heater loud?")
    ).not.toBeInTheDocument();

    // The rest of the answer arrives, including its terminal line. None of it
    // may reach the screen or the store.
    stream.push(delta("Flushing it usually fixes the noise."));
    stream.push(
      done({
        answer: "Sediment in the tank. Flushing it usually fixes the noise.",
        freeRemaining: 2,
        freeLimit: 3,
      })
    );
    await settle();

    expect(
      screen.queryByText("Why is my water heater loud?")
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Sediment in the tank/)).not.toBeInTheDocument();
    // The greeting is what a cleared conversation shows, and nothing was
    // persisted on top of the removal.
    expect(screen.getByText(GREETING)).toBeInTheDocument();
    const stored = window.localStorage.getItem(CHAT_KEY);
    expect(stored === null || stored === JSON.stringify([])).toBe(true);
  });

  it("ignores a storage event for another account's key", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    await ask("Why is my water heater loud?");

    stream.push(delta("Sediment in the tank. "));
    await settle();

    // A different user's chat on the same device (or the pro copilot's key):
    // nothing about this conversation changed.
    await act(async () => {
      otherTabCleared("hearth_ask_chat:user-2");
    });
    stream.push(
      done({
        answer: "Sediment in the tank. Flushing it usually fixes the noise.",
        freeRemaining: 2,
        freeLimit: 3,
      })
    );
    await settle();

    expect(
      screen.getByText("Sediment in the tank. Flushing it usually fixes the noise.")
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Why is my water heater loud?")
    ).toHaveLength(1);
  });

  it("locks Clear and the retention control while the answer is coming", async () => {
    const stream = makeStream();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));

    render(<AskHearth fill />);
    const clear = screen.getByRole("button", { name: "Clear" });
    const retention = screen.getByLabelText("How long chats are kept");
    expect(clear).not.toBeDisabled();
    expect(retention).not.toBeDisabled();

    await ask("Why is my water heater loud?");
    stream.push(delta("Sediment in the tank. "));
    await settle();

    // One gesture away from wiping a conversation an answer is being written
    // into, so both stand down until it lands.
    expect(clear).toBeDisabled();
    expect(retention).toBeDisabled();

    stream.push(
      done({
        answer: "Sediment in the tank. Flushing it usually fixes the noise.",
        freeRemaining: 2,
        freeLimit: 3,
      })
    );
    await settle();
    expect(clear).not.toBeDisabled();
    expect(retention).not.toBeDisabled();
  });
});
