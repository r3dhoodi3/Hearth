// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Same rationale as ProNav.test.tsx: stub the client subsystems that have
// nothing to do with the branch under test. LeadChat in particular opens a
// realtime subscription and AskHearthRow reads localStorage.
vi.mock("@/components/AskHearthRow", () => ({ default: () => <li /> }));
vi.mock("@/components/LeadChat", () => ({ default: () => <div /> }));
vi.mock("@/components/PhoneChatFrame", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ChatsView, {
  type ApplicationRow,
  type SelectedApplication,
} from "./ChatsView";

afterEach(() => {
  cleanup();
});

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
