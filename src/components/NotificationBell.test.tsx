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
  document.documentElement.style.overflow = "";
  document.documentElement.style.overscrollBehavior = "";
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

  // Closes on outside tap, same as the desktop dropdown: a tap anywhere
  // outside the sheet - the backdrop or the page beyond it - closes it.
  it("closes when something outside it is tapped", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
    });
    await settleClose();
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  // Only pointer events close it, never scroll: a touch scroll dispatches a
  // synthesized mousedown at the touch point, which used to be indistinguishable
  // from "tapped outside" and closed the sheet out from under a page that was
  // merely moving. Listening only for mousedown, and never for scroll, keeps a
  // scroll from closing the panel even though an outside tap now does.
  it("stays open when the page behind it scrolls", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.scroll(window);
      fireEvent.scroll(document);
    });
    expect(screen.getByTestId("notification-sheet")).toBeInTheDocument();
  });

  // The backdrop is part of "outside the panel": tapping it closes the sheet
  // just like tapping the page beyond it does.
  it("closes when the dimmed backdrop is tapped", async () => {
    await openPanel();
    const backdrop = screen
      .getByTestId("notification-sheet")
      .querySelector('[aria-hidden="true"]') as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);
    });
    await settleClose();
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  // Tapping inside the sheet itself (not a link or the X) must not close it -
  // only outside taps do. panelRef is what tells the outside-click check the
  // sheet's own content, portalled outside the trigger's DOM subtree, is
  // "inside".
  it("stays open when the sheet's own content is tapped", async () => {
    await openPanel();
    const dialog = screen
      .getByTestId("notification-sheet")
      .querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(dialog);
      fireEvent.click(dialog);
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

  // A live check still found the dashboard scrolling behind the open sheet.
  // body alone only reaches the viewport through the overflow-propagation rule,
  // so the root element is locked directly too, with overscroll-behavior as the
  // backstop for anything that still reaches the page.
  it("locks the root element, not just the body, and restores both", async () => {
    document.documentElement.style.overflow = "auto";
    await openPanel();
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overscrollBehavior).toBe("contain");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    });
    await settleClose();
    // Restored to whatever was there before, never blanked: something else may
    // own it (the chat keyboard panel sets its own).
    expect(document.documentElement.style.overflow).toBe("auto");
    expect(document.documentElement.style.overscrollBehavior).toBe("");
  });

  it("keeps the lock through the sheet's exit animation", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close notifications" }));
    });
    // Still painted (the exit animation has not finished), so the page must
    // still be held: releasing here let it jump under a visible sheet.
    expect(screen.getByTestId("notification-sheet")).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    await settleClose();
    expect(document.body.style.overflow).toBe("");
  });

  it("stops a flick on the sheet itself from reaching the page", async () => {
    await openPanel();
    const sheet = screen.getByTestId("notification-sheet");
    // The list has had overscroll-contain for a while; the sheet box around it
    // (the header lives there, and it is not a scroll container) did not.
    expect(sheet.querySelector('[role="dialog"]')?.className).toContain(
      "overscroll-contain"
    );
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
