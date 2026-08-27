// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import SubmitButton from "./SubmitButton";

afterEach(() => {
  cleanup();
});

describe("SubmitButton", () => {
  it("submits once when clicked twice in rapid succession", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <SubmitButton>Save</SubmitButton>
      </form>
    );
    const button = screen.getByRole("button", { name: "Save" });
    // Two clicks back to back, before React gets a chance to re-render with
    // useFormStatus's pending flipped to true - the exact race that let a
    // fast double tap fire two submits (confirmed live on pro profile Save
    // Changes).
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("stays submittable after the browser blocks a submit for invalid input", () => {
    // Required field left blank: the click fires, the browser refuses the
    // submit, the action never runs, `pending` never flips. The latch must
    // not engage on that click, or the second (valid) attempt would be dead.
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input name="email" required defaultValue="" />
        <SubmitButton>Save</SubmitButton>
      </form>
    );
    const button = screen.getByRole("button", { name: "Save" });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    // jsdom does not run constraint validation on click, so mirror the
    // browser: the click handler runs, then no submit event follows.
    fireEvent.click(button);
    expect(input.checkValidity()).toBe(false);
    fireEvent.change(input, { target: { value: "person@example.com" } });
    expect(input.checkValidity()).toBe(true);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("allows a retry once the in-flight action settles", async () => {
    // A controllable action, so the test can hold `pending` true for as long
    // as it likes before letting it resolve, mirroring a real server action
    // in flight.
    let resolveAction: () => void = () => {};
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        })
    );
    render(
      <form action={action}>
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </form>
    );
    const button = () => screen.getByRole("button");

    // First click starts the action; a second click while it's still
    // pending must not start a second one.
    fireEvent.click(button());
    fireEvent.click(button());
    expect(action).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Saving…")).toBeInTheDocument();

    // Let the in-flight action finish, so `pending` drops back to false and
    // the guard's effect resets it.
    await act(async () => {
      resolveAction();
      await Promise.resolve();
    });

    fireEvent.click(button());
    expect(action).toHaveBeenCalledTimes(2);
  });
});
