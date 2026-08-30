// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The prompt keys everything it remembers on the signed-in account, so two
// people sharing a phone do not inherit each other's dismissals.
const USER_ID = "user-1";
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  }),
}));

import PushPrompt from "./PushPrompt";
import { markPushMoment, SNOOZE_MS } from "@/lib/pushPrompt";

const VAPID = "BIl-j3FtrO2v8sn6QNcEI6llH0Sg_bJPIWOy3c0NdfKqWqAjT4qyGPjzaNWSt-LDUCDPgyHg8tbM4gVqwQreZvk";
const HOMEOWNER_TITLE = "Get notified when a pro replies or sends a quote";
const PRO_TITLE = "Get notified when a homeowner messages you";

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

let existingSubscription: unknown = null;
let requestedPermission: NotificationPermission = "granted";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

function setStandalone(value: boolean | undefined) {
  Object.defineProperty(window.navigator, "standalone", {
    value,
    configurable: true,
  });
}

function fakeSubscription() {
  const endpoint = "https://fcm.googleapis.com/abc";
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => true,
  };
}

// Installs the full push API surface, as an Android Chrome tab would have it.
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
    requestPermission: async () => requestedPermission,
  };
}

// iPhone in a Safari TAB: serviceWorker exists, PushManager does not, and there
// is no Notification global at all. This is the branch the card has to explain.
function installIphoneSafariTab() {
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: { register: async () => ({}), ready: Promise.resolve({}) },
  });
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
  setUserAgent(IOS_SAFARI_UA);
  setStandalone(false);
}

async function mountAfterAMoment(side: "homeowner" | "pro" = "homeowner") {
  markPushMoment();
  const utils = render(<PushPrompt side={side} />);
  // Two ticks: one for the getUser() resolution, one for the async gate check.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

beforeEach(() => {
  window.localStorage.clear();
  existingSubscription = null;
  requestedPermission = "granted";
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = VAPID;
  setUserAgent(ANDROID_CHROME_UA);
  setStandalone(undefined);
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: 0,
    configurable: true,
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
  installPushApis("default");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
});

describe("PushPrompt", () => {
  // NEVER ask cold. A browser gives out notification permission once, and a
  // "no" is close to permanent, so the ask has to follow a moment that makes
  // it obvious why.
  it("stays hidden with no recent moment", async () => {
    render(<PushPrompt side="homeowner" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("push-prompt")).toBeNull();
  });

  it("appears right after a moment, with copy naming the actual event", async () => {
    await mountAfterAMoment("homeowner");
    expect(screen.getByTestId("push-prompt")).toBeInTheDocument();
    expect(screen.getByText(HOMEOWNER_TITLE)).toBeInTheDocument();
  });

  it("names the pro-side event on the pro side", async () => {
    await mountAfterAMoment("pro");
    expect(screen.getByText(PRO_TITLE)).toBeInTheDocument();
  });

  it("goes quiet for 14 days once dismissed", async () => {
    await mountAfterAMoment();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("push-prompt")).toBeNull();

    const until = Number(
      window.localStorage.getItem(`hearth_push_snoozed_until:${USER_ID}`)
    );
    expect(until).toBeGreaterThan(Date.now() + SNOOZE_MS - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + SNOOZE_MS);

    // A fresh mount after another moment stays hidden inside the window.
    cleanup();
    await mountAfterAMoment();
    expect(screen.queryByTestId("push-prompt")).toBeNull();
  });

  it("comes back once the 14 days are up", async () => {
    await mountAfterAMoment();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    cleanup();

    window.localStorage.setItem(
      `hearth_push_snoozed_until:${USER_ID}`,
      String(Date.now() - 1)
    );
    await mountAfterAMoment();
    expect(screen.getByTestId("push-prompt")).toBeInTheDocument();
  });

  it("dismisses via the X as well", async () => {
    await mountAfterAMoment();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("push-prompt")).toBeNull();
    expect(
      Number(window.localStorage.getItem(`hearth_push_snoozed_until:${USER_ID}`))
    ).toBeGreaterThan(Date.now());
  });

  // Never again once it is on: there is nothing left to ask for.
  it("stays hidden when this device is already subscribed", async () => {
    installPushApis("granted");
    existingSubscription = fakeSubscription();
    await mountAfterAMoment();
    expect(screen.queryByTestId("push-prompt")).toBeNull();
  });

  it("stays hidden once the browser has been told no", async () => {
    installPushApis("denied");
    await mountAfterAMoment();
    expect(screen.queryByTestId("push-prompt")).toBeNull();
  });

  it("never asks again after a successful turn-on", async () => {
    await mountAfterAMoment();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
    });
    expect(screen.queryByTestId("push-prompt")).toBeNull();
    expect(window.localStorage.getItem(`hearth_push_done:${USER_ID}`)).toBe("1");
  });

  // The iPhone branch. Safari gives a page no notification permission at all
  // until the site is on the Home Screen, so the card explains that rather than
  // failing on a tap.
  it("tells an iPhone in a Safari tab to add Hearth to the Home Screen", async () => {
    installIphoneSafariTab();
    await mountAfterAMoment();
    expect(screen.getByTestId("push-prompt")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on notifications" }));
    });
    expect(
      screen.getByText(/add Hearth to your Home Screen first/i)
    ).toBeInTheDocument();
  });

  // A deployment with no keys has no working push at all, so there is nothing
  // to offer and the card must not appear.
  it("stays hidden with no VAPID public key", async () => {
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    await mountAfterAMoment();
    expect(screen.queryByTestId("push-prompt")).toBeNull();
  });

  // Phone only: this answers "notify me when the app is closed", which is a
  // phone problem. The permanent control (PushSettingsCard) is not gated.
  it("is phone only", async () => {
    await mountAfterAMoment();
    expect(screen.getByTestId("push-prompt").className).toContain("sm:hidden");
  });

  // It must never cover the fixed bottom tab bar, same offset the install
  // nudge uses.
  it("sits clear of the bottom tab bar", async () => {
    await mountAfterAMoment();
    expect(screen.getByTestId("push-prompt").className).toContain(
      "bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)]"
    );
  });
});
