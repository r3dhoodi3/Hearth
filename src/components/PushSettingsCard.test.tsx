// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PushSettingsCard from "./PushSettingsCard";

// docs/ANALYTICS.md: push_enabled fires client-side once permission is
// actually granted. Mocked so the tests below can assert the event name and
// the enum payload without a real navigator.sendBeacon.
const trackCalls: Array<[string, Record<string, unknown> | undefined]> = [];
vi.mock("@/lib/analytics", () => ({
  track: (event: string, props?: Record<string, unknown>) => {
    trackCalls.push([event, props]);
  },
}));

const VAPID = "BIl-j3FtrO2v8sn6QNcEI6llH0Sg_bJPIWOy3c0NdfKqWqAjT4qyGPjzaNWSt-LDUCDPgyHg8tbM4gVqwQreZvk";
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

let existingSubscription: unknown = null;
let unsubscribeCalls = 0;
let fetchCalls: Array<{ method: string }> = [];

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function fakeSubscription() {
  const endpoint = "https://fcm.googleapis.com/abc";
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      return true;
    },
  };
}

function installPushApis(permission: NotificationPermission) {
  const registration = {
    pushManager: {
      getSubscription: async () => existingSubscription,
      subscribe: async () => fakeSubscription(),
    },
  };
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
  (globalThis as unknown as { Notification: unknown }).Notification = {
    permission,
    requestPermission: async () => permission,
  };
}

// iPhone in a Safari TAB: no PushManager, no Notification global at all.
function installIphoneSafariTab() {
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: { register: async () => ({}), ready: Promise.resolve({}) },
  });
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
  setUserAgent(IOS_SAFARI_UA);
  Object.defineProperty(window.navigator, "standalone", {
    value: false,
    configurable: true,
  });
}

async function mount(side: "homeowner" | "pro" = "homeowner") {
  const utils = render(<PushSettingsCard side={side} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

beforeEach(() => {
  existingSubscription = null;
  unsubscribeCalls = 0;
  fetchCalls = [];
  trackCalls.length = 0;
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = VAPID;
  setUserAgent(ANDROID_CHROME_UA);
  Object.defineProperty(window.navigator, "standalone", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: 0,
    configurable: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      fetchCalls.push({ method: init?.method ?? "GET" });
      return { ok: true } as Response;
    })
  );
  installPushApis("default");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
});

describe("PushSettingsCard", () => {
  // The copy names the actual event on each side, which is what makes the
  // browser's permission prompt that follows make sense.
  it("offers the button with side-specific copy", async () => {
    await mount("pro");
    expect(
      screen.getByText("Get notified when a homeowner messages you")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Turn on notifications" })
    ).toBeInTheDocument();
  });

  it("uses the homeowner wording on the homeowner side", async () => {
    await mount("homeowner");
    expect(
      screen.getByText("Get notified when a pro replies or sends a quote")
    ).toBeInTheDocument();
  });

  it("shows the on state for a device that is already subscribed", async () => {
    installPushApis("granted");
    existingSubscription = fakeSubscription();
    await mount();
    expect(
      screen.getByText("Notifications are on for this device.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
  });

  it("turns on and posts the subscription", async () => {
    installPushApis("granted");
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
    });
    expect(fetchCalls).toEqual([{ method: "POST" }]);
    expect(
      screen.getByText("Notifications are on for this device.")
    ).toBeInTheDocument();
  });

  it("records push_enabled with the side, no free text, once granted", async () => {
    installPushApis("granted");
    await mount("pro");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
    });
    expect(trackCalls).toEqual([["push_enabled", { side: "pro" }]]);
  });

  it("does not record push_enabled when the prompt is dismissed unanswered", async () => {
    // installPushApis("default"): the browser prompt appears (button is
    // visible, unlike the already-denied case) but requestPermission
    // resolves to a non-answer, which enablePush treats as "dismissed".
    installPushApis("default");
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
    });
    expect(trackCalls).toEqual([]);
  });

  it("turns off by unsubscribing and telling the server to forget the device", async () => {
    installPushApis("granted");
    existingSubscription = fakeSubscription();
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Turn off/ }));
    });
    expect(unsubscribeCalls).toBe(1);
    expect(fetchCalls).toEqual([{ method: "DELETE" }]);
  });

  // A blocked browser is the one state nothing in the app can fix, so the card
  // says where the switch actually lives instead of offering a dead button.
  it("explains a blocked browser and offers no button", async () => {
    installPushApis("denied");
    await mount();
    expect(screen.getByText(/blocked for Hearth in this browser/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
  });

  // The iPhone case. Detection has to run BEFORE the capability check, or a
  // Safari tab reads as "unsupported" and the card hides from exactly the
  // person who needs the one instruction that fixes it.
  it("tells an iPhone in a Safari tab to add Hearth to the Home Screen", async () => {
    installIphoneSafariTab();
    await mount();
    expect(
      screen.getByText(/add Hearth to your Home Screen first/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
  });

  it("says notifications are not switched on yet when the deployment has no VAPID key", async () => {
    // Changed 2026-08-30 after live checks L2/L3: the card used to vanish on
    // hydration, which read as a broken page; now it states the situation and
    // offers no button (nothing to tap could succeed).
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    await mount();
    expect(screen.getByTestId("push-settings-card")).toBeTruthy();
    expect(screen.getByText(/not switched on yet/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing on a browser that cannot do push at all", async () => {
    // No serviceWorker and no PushManager, and not an iPhone either.
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    delete (globalThis as unknown as { Notification?: unknown }).Notification;
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: undefined,
    });
    await mount();
    expect(screen.queryByTestId("push-settings-card")).toBeNull();
  });
});
