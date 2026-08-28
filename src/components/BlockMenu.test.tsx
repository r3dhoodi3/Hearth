// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The action is a "use server" module in production; the component only ever
// calls it as a plain function, so the default import is stubbed to keep this
// test in the UI layer. Every test below passes its own `action` prop anyway
// - this mock exists so importing the component does not drag the Supabase
// server client into a jsdom run.
vi.mock("@/app/(app)/account/blocks/actions", () => ({
  blockUserAction: vi.fn(async () => ({ ok: true })),
  unblockUserAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

import BlockMenu from "./BlockMenu";

afterEach(cleanup);

function open() {
  fireEvent.click(screen.getByRole("button", { name: /more options/i }));
}

describe("BlockMenu", () => {
  it("does not block on the first tap: menu, then confirm, then the write", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<BlockMenu leadId="lead-1" personLabel="this pro" action={action} />);

    // Closed. Nothing about blocking is on screen yet.
    expect(screen.queryByText(/block this pro/i)).not.toBeInTheDocument();

    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));

    // Confirm step. Still nothing written.
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(/block this pro\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("sends the lead, not a user id, so the server resolves who to block", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<BlockMenu leadId="lead-1" personLabel="this pro" action={action} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get("lead_id")).toBe("lead-1");
    expect(sent.get("blocked_user_id")).toBeNull();
  });

  it("sends the contractor id from a profile block", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(
      <BlockMenu contractorId="pro-1" personLabel="Acme Plumbing" action={action} />
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: /block acme plumbing/i }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get("contractor_id")).toBe("pro-1");
  });

  it("cancelling the confirm writes nothing", () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<BlockMenu leadId="lead-1" personLabel="this pro" action={action} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByText(/block this pro\?/i)).not.toBeInTheDocument();
  });

  it("disables the confirm button while the block is in flight", async () => {
    let release: (v: { ok: true }) => void = () => {};
    const action = vi.fn(
      (_fd: FormData) => new Promise<{ ok: true }>((resolve) => (release = resolve))
    );
    render(<BlockMenu leadId="lead-1" personLabel="this pro" action={action} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));

    const confirm = screen.getByRole("button", { name: "Block" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());

    release({ ok: true });
    await waitFor(() =>
      expect(screen.getByText(/^Blocked\./)).toBeInTheDocument()
    );
  });

  it("shows the undo path once the block lands", async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(
      <BlockMenu
        leadId="lead-1"
        personLabel="this homeowner"
        manageHref="/pro/blocks"
        action={action}
      />
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this homeowner/i }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    const link = await screen.findByRole("link", {
      name: /manage blocked accounts/i,
    });
    expect(link).toHaveAttribute("href", "/pro/blocks");
  });

  it("says plainly that a block does not cancel work already underway", async () => {
    // 0138 guards message INSERT and apply_to_lead, NOT can_access_lead: a pro
    // blocked mid-job still opens the thread they are assigned to. The confirm
    // step has to promise only what the database actually enforces.
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(<BlockMenu leadId="lead-1" personLabel="this pro" action={action} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));

    expect(
      screen.getByText(/does not cancel a job or conversation you already have/i)
    ).toBeInTheDocument();
    // And what a block DOES stop, in the same words the server enforces.
    expect(
      screen.getByText(/message you or apply to jobs you post from now on/i)
    ).toBeInTheDocument();
  });

  it("offers the screen's own end-conversation control where there is one", async () => {
    const onEnd = vi.fn();
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(
      <BlockMenu
        leadId="lead-1"
        personLabel="this pro"
        onEndConversation={onEnd}
        action={action}
      />
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));

    fireEvent.click(screen.getByRole("button", { name: /end this conversation/i }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    // Ending is not blocking: nothing was written by that tap.
    expect(action).not.toHaveBeenCalled();
  });

  it("shows no end control where the screen has nothing to end", async () => {
    // A pro's public profile has no conversation attached to it.
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    render(
      <BlockMenu contractorId="pro-1" personLabel="Acme Plumbing" action={action} />
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: /block acme plumbing/i }));

    expect(
      screen.queryByRole("button", { name: /end this conversation/i })
    ).not.toBeInTheDocument();
    // The honest line is still there, worded for a surface with no thread.
    expect(
      screen.getByText(/does not cancel a job or conversation you already have/i)
    ).toBeInTheDocument();
  });

  it("stays on the confirm step and shows the reason when the server refuses", async () => {
    const action = vi.fn(async (_fd: FormData) => ({
      ok: false as const,
      error: "Blocking isn't switched on yet.",
    }));
    render(<BlockMenu leadId="lead-1" personLabel="this pro" action={action} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /block this pro/i }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /isn't switched on yet/i
    );
    // Never claims a block that did not happen.
    expect(screen.queryByText(/^Blocked\./)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block" })).toBeEnabled();
  });
});
