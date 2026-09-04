import { describe, expect, it, vi, beforeEach } from "vitest";

const trackServerEvent = vi.fn(
  async (_userId: string | null, _event: string, _props?: Record<string, unknown>) => {}
);
vi.mock("@/lib/trackServer", () => ({
  trackServerEvent: (userId: string | null, event: string, props?: Record<string, unknown>) =>
    trackServerEvent(userId, event, props),
}));

import {
  hasGlobalPrivacyControl,
  logGpcSignalOncePerSession,
  GPC_SEEN_COOKIE,
} from "./gpc";

function jar(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (name: string) => {
      const value = store.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      store.set(name, value);
    },
  };
}

beforeEach(() => {
  trackServerEvent.mockClear();
});

describe("hasGlobalPrivacyControl", () => {
  it("is true only for the exact 'Sec-GPC: 1' signal", () => {
    expect(hasGlobalPrivacyControl(new Headers({ "Sec-GPC": "1" }))).toBe(true);
    // Headers is case-insensitive by spec, both for the name...
    expect(hasGlobalPrivacyControl(new Headers({ "sec-gpc": "1" }))).toBe(true);
  });

  it("is false when the header is absent, empty, or any other value", () => {
    expect(hasGlobalPrivacyControl(new Headers())).toBe(false);
    expect(hasGlobalPrivacyControl(new Headers({ "Sec-GPC": "0" }))).toBe(false);
    expect(hasGlobalPrivacyControl(new Headers({ "Sec-GPC": "true" }))).toBe(false);
  });
});

describe("logGpcSignalOncePerSession", () => {
  it("does nothing when the signal is absent", async () => {
    const cookies = jar();
    await logGpcSignalOncePerSession(new Headers(), cookies, "user-1");
    expect(trackServerEvent).not.toHaveBeenCalled();
    expect(cookies.store.has(GPC_SEEN_COOKIE)).toBe(false);
  });

  it("logs the event and sets the session marker on first sight", async () => {
    const cookies = jar();
    const headers = new Headers({ "Sec-GPC": "1" });
    await logGpcSignalOncePerSession(headers, cookies, "user-1");
    expect(trackServerEvent).toHaveBeenCalledTimes(1);
    expect(trackServerEvent).toHaveBeenCalledWith("user-1", "gpc_signal_seen", {});
    expect(cookies.store.get(GPC_SEEN_COOKIE)).toBe("1");
  });

  it("does not log a second time once the session marker is set", async () => {
    const cookies = jar({ [GPC_SEEN_COOKIE]: "1" });
    const headers = new Headers({ "Sec-GPC": "1" });
    await logGpcSignalOncePerSession(headers, cookies, "user-1");
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("sets the cookie but never writes an event for a signed-out visitor", async () => {
    // Middleware passes null for every request. Writing a service-role row
    // for an anonymous client that can drop the cookie and resend the header
    // would be an unbounded insert per request, so only the cookie is set.
    const cookies = jar();
    const headers = new Headers({ "Sec-GPC": "1" });
    await logGpcSignalOncePerSession(headers, cookies, null);
    expect(cookies.get("hearth_gpc_seen")?.value).toBe("1");
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});
