// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Stubbed for the same reason as BlockMenu.test.tsx: the real module is a
// "use server" file that pulls in the Supabase server client. Every test
// passes its own `action` prop.
vi.mock("@/lib/reportActions", () => ({
  reportContentAction: vi.fn(async () => ({ ok: true })),
}));

import ReportSheet from "./ReportSheet";
import { REPORT_REASONS } from "@/lib/reportReasons";

afterEach(cleanup);

function openSheet(name = /report/i) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("ReportSheet", () => {
  it("is a quiet link until it is opened", () => {
    render(<ReportSheet targetType="review" targetId="review-1" />);
    expect(screen.getByRole("button", { name: "Report" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("offers the shared reason list and an optional note", () => {
    render(<ReportSheet targetType="review" targetId="review-1" />);
    openSheet();
    const select = screen.getByRole("combobox", { name: /reason/i });
    expect(select).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(REPORT_REASONS.length);
    expect(
      screen.getByRole("textbox", { name: /anything else/i })
    ).toBeInTheDocument();
  });

  it("sends the target, the picked reason and the note", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(
      <ReportSheet targetType="contractor" targetId="pro-1" action={action} />
    );
    openSheet();
    fireEvent.change(screen.getByRole("combobox", { name: /reason/i }), {
      target: { value: "Spam or a scam" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /anything else/i }), {
      target: { value: "wanted a wire transfer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get("target_type")).toBe("contractor");
    expect(sent.get("target_id")).toBe("pro-1");
    expect(sent.get("reason")).toBe("Spam or a scam");
    expect(sent.get("note")).toBe("wanted a wire transfer");
  });

  it("defaults to the first reason so a one-tap report still says something", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<ReportSheet targetType="review" targetId="review-1" action={action} />);
    openSheet();
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get("reason")).toBe(REPORT_REASONS[0]);
  });

  it("disables the send button while the report is in flight", async () => {
    let release: (v: { ok: true }) => void = () => {};
    const action = vi.fn(
      (_fd: FormData) => new Promise<{ ok: true }>((resolve) => (release = resolve))
    );
    render(<ReportSheet targetType="review" targetId="review-1" action={action} />);
    openSheet();
    const send = screen.getByRole("button", { name: /send report/i });
    fireEvent.click(send);
    await waitFor(() => expect(send).toBeDisabled());

    release({ ok: true });
    await waitFor(() =>
      expect(screen.getByText(/thanks, we'll take a look\./i)).toBeInTheDocument()
    );
  });

  it("confirms in plain words and puts the form away", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<ReportSheet targetType="review" targetId="review-1" action={action} />);
    openSheet();
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    expect(
      await screen.findByText(/thanks, we'll take a look\./i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows the server's own line when this was already reported", async () => {
    // A duplicate is a 23505 on 0139's unique index, which the action reports
    // as success carrying the line to show. Anything else would read as a
    // failure and get the same report filed a third time.
    const action = vi.fn(async (_fd: FormData) => ({
      ok: true as const,
      data: "You've already reported this. Thanks, we'll take a look.",
    }));
    render(<ReportSheet targetType="review" targetId="review-1" action={action} />);
    openSheet();
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    expect(
      await screen.findByText(/you've already reported this/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps the form open with the error when the server refuses", async () => {
    const action = vi.fn(async (_fd: FormData) => ({
      ok: false as const,
      error: "You've sent several reports already.",
    }));
    render(<ReportSheet targetType="review" targetId="review-1" action={action} />);
    openSheet();
    fireEvent.change(screen.getByRole("combobox", { name: /reason/i }), {
      target: { value: "Hate speech or threats" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send report/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /several reports already/i
    );
    // Never thanks somebody for a report that was refused, and the reason
    // they picked survives so a retry is one tap.
    expect(screen.queryByText(/thanks, we'll take a look/i)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /reason/i })).toHaveValue(
      "Hate speech or threats"
    );
  });

  it("cancelling closes the form without reporting", () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<ReportSheet targetType="review" targetId="review-1" action={action} />);
    openSheet();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
