// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same rationale as ProNav.test.tsx: stub the client subsystems that have
// nothing to do with the branch under test. LeadChat in particular opens a
// realtime subscription and AskHearthRow reads localStorage. The stub keeps
// its visible name so the tab tests can assert the pinned row never leaves.
vi.mock("@/components/AskHearthRow", () => ({
  default: () => <li>Ask Hearth</li>,
}));
vi.mock("@/components/LeadChat", () => ({ default: () => <div /> }));
vi.mock("@/components/PhoneChatFrame", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ChatsView, {
  type ApplicationRow,
  type ChatRow,
  type SelectedApplication,
} from "./ChatsView";

afterEach(() => {
  cleanup();
});

const activeRow: ChatRow = {
  id: "lead-active",
  title: "Dana Homeowner",
  categoryLabel: "Plumbing",
  preview: "You: On my way",
  unread: false,
  active: false,
  terminal: false,
};

const closedRow: ChatRow = {
  id: "lead-closed",
  title: "Sam Finished",
  categoryLabel: "Roofing",
  preview: "Thanks again!",
  unread: false,
  active: false,
  terminal: true,
};

const appRow: ApplicationRow = {
  id: "app-1",
  title: "Roofing",
  dateLabel: "Aug 29",
  preview: "You: I can start next week",
  active: false,
};

const selectedApplication: SelectedApplication = {
  id: "app-1",
  title: "Roofing",
  subtitle: "Applied Aug 29",
  message: "I can start next week and I have done this street before.",
  statusLine:
    "Sent Aug 29. The homeowner has not replied yet. If they pick you, this becomes a conversation.",
  noteLine:
    "If the homeowner never responds within 7 days, you always get the fee back as credit, every time, no limit.",
};

// The Active / Closed tabs over the conversation list. Classification happens
// on the server (ChatRow.terminal, from the shared isTerminalLeadStatus); the
// component only has to put each row under the right tab and keep the pinned
// rows out of the filter entirely.
describe("pro Messages: Active / Closed tabs", () => {
  function renderTabs(extra: Partial<Parameters<typeof ChatsView>[0]> = {}) {
    return render(
      <ChatsView
        rows={[activeRow, closedRow]}
        applicationRows={[]}
        askUserId={null}
        threadOpenOnMobile={false}
        selected={null}
        {...extra}
      />
    );
  }

  it("defaults to Active: ongoing rows show, finished ones do not", () => {
    renderTabs();
    expect(screen.getByText("Dana Homeowner")).toBeInTheDocument();
    expect(screen.queryByText("Sam Finished")).toBeNull();
    expect(screen.getByRole("button", { name: /Active/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows the finished conversation under Closed, and only there", () => {
    renderTabs();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(screen.getByText("Sam Finished")).toBeInTheDocument();
    expect(screen.queryByText("Dana Homeowner")).toBeNull();
  });

  it("keeps the pinned Ask Hearth and Find clients rows on both tabs", () => {
    renderTabs();
    expect(screen.getByText("Ask Hearth")).toBeInTheDocument();
    expect(screen.getByText("Find clients")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(screen.getByText("Ask Hearth")).toBeInTheDocument();
    expect(screen.getByText("Find clients")).toBeInTheDocument();
  });

  it("counts each tab off the rows it was handed", () => {
    renderTabs();
    expect(screen.getByRole("button", { name: "Active (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Closed (1)" })).toBeInTheDocument();
  });

  it("shows each tab's empty state in plain words", () => {
    render(
      <ChatsView
        rows={[]}
        applicationRows={[]}
        askUserId={null}
        threadOpenOnMobile={false}
        selected={null}
      />
    );
    expect(
      screen.getByText(/No open conversations yet\. Find clients to start one/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(
      screen.getByText("Nothing here yet. Finished conversations land here.")
    ).toBeInTheDocument();
  });

  it("starts on Closed when the open thread is a finished one", () => {
    renderTabs({ initialTab: "closed" });
    expect(screen.getByText("Sam Finished")).toBeInTheDocument();
    expect(screen.queryByText("Dana Homeowner")).toBeNull();
  });

  it("keeps the waiting applications on the Active tab only", () => {
    renderTabs({ applicationRows: [appRow] });
    expect(screen.getByText("Waiting on the homeowner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Closed/ }));
    expect(screen.queryByText("Waiting on the homeowner")).toBeNull();
  });
});

describe("pro Messages: applications waiting on the homeowner", () => {
  it("lists them in their own section under the conversations", () => {
    render(
      <ChatsView
        rows={[]}
        applicationRows={[appRow]}
        askUserId={null}
        threadOpenOnMobile={false}
        selected={null}
      />
    );
    expect(screen.getByText("Waiting on the homeowner")).toBeInTheDocument();
    // The row carries the job category, the date, and what the pro wrote.
    expect(screen.getByText("Roofing")).toBeInTheDocument();
    expect(screen.getByText("Aug 29")).toBeInTheDocument();
    expect(screen.getByText("You: I can start next week")).toBeInTheDocument();
  });

  it("opens the application through ?application=, not ?lead=", () => {
    render(
      <ChatsView
        rows={[]}
        applicationRows={[appRow]}
        askUserId={null}
        threadOpenOnMobile={false}
        selected={null}
      />
    );
    const link = screen.getByRole("link", { name: /Roofing/ });
    expect(link).toHaveAttribute("href", "/pro/chats?application=app-1");
  });

  it("renders no section at all when nothing is pending", () => {
    render(
      <ChatsView
        rows={[]}
        applicationRows={[]}
        askUserId={null}
        threadOpenOnMobile={false}
        selected={null}
      />
    );
    expect(screen.queryByText("Waiting on the homeowner")).toBeNull();
  });

  it("never marks an application row unread", () => {
    // An application is the pro's own outgoing note, so there is nothing in it
    // to have missed. The "New" pill belongs to conversation rows only.
    const { container } = render(
      <ChatsView
        rows={[]}
        applicationRows={[appRow]}
        askUserId={null}
        threadOpenOnMobile={false}
        selected={null}
      />
    );
    expect(screen.queryByText("New")).toBeNull();
    expect(container.innerHTML).not.toContain("bg-hearth-600");
  });
});

describe("pro Messages: the open application pane", () => {
  function renderPane() {
    return render(
      <ChatsView
        rows={[]}
        applicationRows={[{ ...appRow, active: true }]}
        askUserId={null}
        threadOpenOnMobile
        selected={null}
        selectedApplication={selectedApplication}
      />
    );
  }

  it("shows the full application message and the status lines", () => {
    renderPane();
    expect(
      screen.getByText(
        "I can start next week and I have done this street before."
      )
    ).toBeInTheDocument();
    expect(screen.getByText(selectedApplication.statusLine)).toBeInTheDocument();
    expect(screen.getByText(selectedApplication.noteLine)).toBeInTheDocument();
  });

  it("has no composer, and says why", () => {
    renderPane();
    // No text field of any kind: a pro cannot message a homeowner who has not
    // picked them, so a disabled input would be a lie about what they can do.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    expect(
      screen.getByText(/You cannot message this homeowner yet/)
    ).toBeInTheDocument();
  });

  it("does not fall through to the empty placeholder", () => {
    renderPane();
    expect(screen.queryByText("Select a conversation")).toBeNull();
  });
});
