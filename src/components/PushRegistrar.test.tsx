// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PushRegistrar from "./PushRegistrar";

// jsdom has none of the push APIs, so each test installs the pieces it needs.
// This is the same surface a real browser exposes: navigator.serviceWorker,
// window.PushManager, and the global Notification.

const VAPID = "BIl-j3FtrO2v8sn6QNcEI6llH0Sg_bJPIWOy3c0NdfKqWqAjT4qyGPjzaNWSt-LDUCDPgyHg8tbM4gVqwQreZvk";

let registerCalls: string[] = [];
let subscribeCalls = 0;
let existingSubscription: unknown = null;
let fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];

function fakeSubscription(endpoint = "https://web.push.apple.com/abc") {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => true,
  };
}

function installPushApis(permission: NotificationPermission) {
  const registration = {
    pushManager: {
      getSubscription: async () => existingSubscription,
      subscribe: async () => {
        subscribeCalls += 1;
        return fakeSubscription();
      },
    },
  };
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: async (url: string) => {
        registerCalls.push(url);
        return registration;
      },
      ready: Promise.resolve(registration),
    },
  });
  // `"PushManager" in window` is the capability check pushSupported() makes.
  (window as unknown as { PushManager: unknown }).PushManager = function () {};
  (globalThis as unknown as { Notification: unknown }).Notification = {
    permission,
    requestPermission: async () => permission,
  };
}

beforeEach(() => {
  registerCalls = [];
  subscribeCalls = 0;
  existingSubscription = null;
  fetchCalls = [];
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = VAPID;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return { ok: true } as Response;
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
  // The registration path no longer needs PushManager, so a serviceWorker mock
  // left behind by one test would make the "no service worker at all" test
  // register anyway. installPushApis defines it configurable for this delete.
  delete (window.navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

describe("PushRegistrar", () => {
  it("registers the service worker exactly once", async () => {
    installPushApis("default");
    await act(async () => {
      render(<PushRegistrar side="homeowner" />);
    });
    expect(registerCalls).toEqual(["/sw.js"]);
  });

  // React strict mode double-invokes effects in development, and this effect
  // makes a network call, so the ref guard inside is load bearing.
  it("does not register twice when the effect re-runs", async () => {
    installPushApis("default");
    const { rerender } = render(<PushRegistrar side="homeowner" />);
    await act(async () => {
      rerender(<PushRegistrar side="homeowner" />);
    });
    expect(registerCalls.length).toBe(1);
  });

  // The whole point of decoupling registration from push support: a browser
  // with service workers but no push APIs (no PushManager, no Notification)
  // still gets the worker, because its warming-screen half serves everyone.
  // Only navigator.serviceWorker is installed here, nothing else.
  it("registers on a browser with service workers but no push APIs", async () => {
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async (url: string) => {
          registerCalls.push(url);
          return {};
        },
        ready: Promise.resolve({}),
      },
    });
    await act(async () => {
      render(<PushRegistrar side="homeowner" />);
    });
    expect(registerCalls).toEqual(["/sw.js"]);
    expect(subscribeCalls).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  // Never prompts: with permission still "default", asking would need a user
  // gesture and would burn the one chance to ask.
  it("does not subscribe or call the server when permission is not granted", async () => {
    installPushApis("default");
    await act(async () => {
      render(<PushRegistrar side="homeowner" />);
    });
    expect(subscribeCalls).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  // The self-healing half: a browser can drop a subscription on its own, so
  // once permission is granted every visit re-posts the current one.
  it("refreshes the subscription and posts it when permission is already granted", async () => {
    installPushApis("granted");
    await act(async () => {
      render(<PushRegistrar side="pro" />);
    });
    expect(subscribeCalls).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].url).toBe("/api/push/subscribe");
    expect(fetchCalls[0].body).toEqual({
      endpoint: "https://web.push.apple.com/abc",
      keys: { p256dh: "p", auth: "a" },
      side: "pro",
    });
  });

  it("reuses an existing subscription instead of creating a second one", async () => {
    installPushApis("granted");
    existingSubscription = fakeSubscription("https://fcm.googleapis.com/xyz");
    await act(async () => {
      render(<PushRegistrar side="homeowner" />);
    });
    expect(subscribeCalls).toBe(0);
    expect(fetchCalls[0].body).toMatchObject({
      endpoint: "https://fcm.googleapis.com/xyz",
    });
  });

  // The worker also serves the cold-start warming screen now, so it registers
  // even on a deployment with no VAPID keys; only the push half stays dormant
  // (no subscribe, no server call) until the keys arrive.
  it("registers the worker without a VAPID public key but never subscribes", async () => {
    installPushApis("granted");
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    await act(async () => {
      render(<PushRegistrar side="homeowner" />);
    });
    expect(registerCalls).toEqual(["/sw.js"]);
    expect(subscribeCalls).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  it("does nothing on a browser with no service worker at all", async () => {
    // jsdom's default: no navigator.serviceWorker, no PushManager. An old
    // browser, or iOS Safari in a plain tab.
    await act(async () => {
      render(<PushRegistrar side="homeowner" />);
    });
    expect(registerCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });
});
