// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// One notification, enough to render a row and the "Mark all read" control.
const ROWS = [
  {
    id: "n1",
    kind: "message",
    title: "New message",
    body: "Dave replied about the water heater",
    url: "/chats?lead=1",
    read_at: null,
    created_at: new Date().toISOString(),
  },
];

// Every postgres_changes config the component hands to supabase-js, so the
// test can assert the subscription is scoped to the signed-in user rather than
// asking for the whole notifications table.
const realtime = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const api: Record<string, unknown> = {};
      Object.assign(api, {
        select: () => api,
        order: () => api,
        limit: async () => ({ data: ROWS }),
        is: async () => ({ count: 1 }),
        update: () => api,
        in: async () => ({ error: null }),
      });
      return api;
    },
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    channel: () => ({
      on: function (_event: string, config: Record<string, unknown>) {
        realtime.configs.push(config);
        return this;
      },
      subscribe: () => ({}),
    }),
    removeChannel: () => {},
  }),
}));

import NotificationBell from "./NotificationBell";

// jsdom has no matchMedia, and this component uses it to decide between the
// desktop dropdown and the phone sheet.
let phoneWidth = false;
function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width") ? phoneWidth : !phoneWidth,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

async function openPanel() {
  const utils = render(<NotificationBell />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

// The panel stays mounted for one more tick after closing so it can play its
// exit animation (see `closing` in the component), so every close assertion
// has to wait that out.
async function settleClose() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

beforeEach(() => {
  phoneWidth = false;
  realtime.configs.length = 0;
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("NotificationBell realtime", () => {
  // Without a filter the client asks the realtime server for every INSERT on
  // public.notifications and relies on RLS alone to trim it. Scoped to the
  // signed-in user, nobody else's row is ever considered.
  it("subscribes only to the signed-in user's notifications", async () => {
    render(<NotificationBell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(realtime.configs).toHaveLength(1);
    expect(realtime.configs[0]).toMatchObject({
      event: "INSERT",
      table: "notifications",
      filter: "user_id=eq.user-1",
    });
  });
});

describe("NotificationBell on desktop", () => {
  it("renders the dropdown, not the sheet", async () => {
    await openPanel();
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  // Standard dropdown behavior, deliberately kept: a mouse user expects a
  // click elsewhere to dismiss it.
  it("still closes on a click outside", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    await settleClose();
    expect(screen.queryByTestId("notification-panel")).toBeNull();
  });

  it("closes on Escape", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await settleClose();
    expect(screen.queryByTestId("notification-panel")).toBeNull();
  });
});

describe("NotificationBell on a phone", () => {
  beforeEach(() => {
    phoneWidth = true;
    installMatchMedia();
  });

  it("opens as a bottom sheet instead of a dropdown", async () => {
    await openPanel();
    const sheet = screen.getByTestId("notification-sheet");
    expect(sheet).toBeInTheDocument();
    expect(screen.queryByTestId("notification-panel")).toBeNull();
    // Anchored to the bottom of the viewport and above the fixed tab bar.
    expect(sheet.querySelector('[role="dialog"]')?.className).toContain(
      "fixed inset-x-0 bottom-0"
    );
  });

  // THE REPORTED BUG: tapping the bell and then scrolling or touching anywhere
  // dropped the list, so it had to be reopened. A touch scroll dispatches a
  // synthesized mousedown at the touch point, which is indistinguishable from
  // "tapped outside" - so on the phone that listener is gone entirely.
  it("stays open when something outside it is tapped", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
    });
    expect(screen.getByTestId("notification-sheet")).toBeInTheDocument();
  });

  it("stays open when the page behind it scrolls", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.scroll(window);
      fireEvent.scroll(document);
    });
    expect(screen.getByTestId("notification-sheet")).toBeInTheDocument();
  });

  // The backdrop dims the page but is not a close affordance: the owner asked
  // for a panel that stays put until the X.
  it("stays open when the dimmed backdrop is tapped", async () => {
    await openPanel();
    const backdrop = screen
      .getByTestId("notification-sheet")
      .querySelector('[aria-hidden="true"]') as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);
    });
    expect(screen.getByTestId("notification-sheet")).toBeInTheDocument();
  });

  it("closes on the X", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    });
    await settleClose();
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  it("closes when a notification is opened", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.click(screen.getByText("New message"));
    });
    await settleClose();
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  it("holds the page still while the sheet is open", async () => {
    await openPanel();
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    });
    await settleClose();
    expect(document.body.style.overflow).toBe("");
  });

  // Tap targets the eyesight pass flagged: the X, the rows, and "Mark all
  // read" all have to clear 44px on a phone.
  it("gives the X, the rows and Mark all read a 44px target", async () => {
    await openPanel();
    expect(
      screen.getByRole("button", { name: "Close notifications" }).className
    ).toContain("h-11 w-11");
    expect(
      screen.getByRole("button", { name: /Mark all read/ }).className
    ).toContain("max-sm:min-h-11");
    expect(screen.getByRole("link", { name: /New message/ }).className).toContain(
      "max-sm:min-h-11"
    );
  });
});
