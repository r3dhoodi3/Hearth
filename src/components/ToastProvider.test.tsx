// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import ToastProvider, { useToast, type ToastOptions } from "./ToastProvider";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
});

// A button per toast type, so a test can fire one and then watch the clock.
function Harness({ opts }: { opts?: ToastOptions }) {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.error("Something broke", opts)}>
        fire error
      </button>
      <button type="button" onClick={() => toast.success("Saved", opts)}>
        fire success
      </button>
    </>
  );
}

function renderHarness(opts?: ToastOptions) {
  return render(
    <ToastProvider>
      <Harness opts={opts} />
    </ToastProvider>
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("ToastProvider error auto-dismiss", () => {
  // Errors used to have duration 0 (persist until dismissed). The owner found
  // pressing the X on every error annoying, and an error worth acting on
  // re-fires on the next retry, so five seconds is the default now.
  it("clears an error toast on its own after five seconds", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "fire error" }));
    expect(screen.getByText("Something broke")).toBeInTheDocument();

    // Still up at 4.9s: the message has to be readable, not just present.
    advance(4900);
    expect(screen.queryByText("Something broke")).toBeInTheDocument();

    // 5s timer, then the short exit animation before the node is removed.
    advance(200);
    advance(200);
    expect(screen.queryByText("Something broke")).not.toBeInTheDocument();
  });

  it("still lets a caller pin an error with duration 0", () => {
    renderHarness({ duration: 0 });
    fireEvent.click(screen.getByRole("button", { name: "fire error" }));
    advance(30000);
    expect(screen.getByText("Something broke")).toBeInTheDocument();
  });

  it("keeps the manual dismiss button working", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "fire error" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    advance(400);
    expect(screen.queryByText("Something broke")).not.toBeInTheDocument();
  });

  it("holds an error on screen while the pointer is over it", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "fire error" }));
    const card = screen.getByText("Something broke").closest("li") as HTMLElement;

    fireEvent.mouseEnter(card.firstElementChild as HTMLElement);
    advance(20000);
    expect(screen.getByText("Something broke")).toBeInTheDocument();

    // Leaving restarts the full five seconds, so the reader never loses it
    // mid-sentence.
    fireEvent.mouseLeave(card.firstElementChild as HTMLElement);
    advance(4900);
    expect(screen.getByText("Something broke")).toBeInTheDocument();
    advance(400);
    expect(screen.queryByText("Something broke")).not.toBeInTheDocument();
  });

  it("leaves the shorter success default alone", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "fire success" }));
    advance(3900);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    advance(400);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("honours an explicit longer duration, which is how the maintenance-plan flash gets its extra 2s", () => {
    renderHarness({ duration: 6000 });
    fireEvent.click(screen.getByRole("button", { name: "fire success" }));
    advance(4400);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    advance(1800);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
