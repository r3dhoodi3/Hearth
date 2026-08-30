import { describe, expect, it } from "vitest";
import {
  buildPushPayload,
  deliverPush,
  isDeadSubscriptionStatus,
  pushConfigured,
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  type StoredPushSubscription,
} from "./pushDelivery";

function sub(id: string): StoredPushSubscription {
  return {
    id,
    endpoint: `https://web.push.apple.com/${id}`,
    p256dh: "key",
    auth: "auth",
  };
}

describe("buildPushPayload", () => {
  it("produces exactly the four fields public/sw.js reads", () => {
    const parsed = JSON.parse(
      buildPushPayload({
        title: "New message",
        body: "Dave replied about the water heater",
        url: "/chats?lead=abc",
        tag: "message:/chats?lead=abc",
      })
    );
    expect(parsed).toEqual({
      title: "New message",
      body: "Dave replied about the water heater",
      url: "/chats?lead=abc",
      tag: "message:/chats?lead=abc",
    });
  });

  it("defaults a missing body and tag rather than emitting undefined", () => {
    const parsed = JSON.parse(buildPushPayload({ title: "Freeze tonight" }));
    expect(parsed.body).toBe("");
    expect(parsed.tag).toBe("hearth");
    expect(parsed.url).toBe("/dashboard");
  });

  // The url arrives from callers that build it out of database values, and the
  // service worker will open whatever it is handed. Anything that is not a
  // same-origin path is replaced at BOTH ends.
  it.each([
    "https://evil.example/steal",
    "//evil.example",
    "javascript:alert(1)",
    "",
  ])("refuses %s as a destination", (url) => {
    expect(JSON.parse(buildPushPayload({ title: "x", url })).url).toBe("/dashboard");
  });

  it("clips a long title and body so the payload fits the 4KB push limit", () => {
    const parsed = JSON.parse(
      buildPushPayload({ title: "t".repeat(500), body: "b".repeat(2000) })
    );
    expect(parsed.title.length).toBe(PUSH_TITLE_MAX);
    expect(parsed.body.length).toBe(PUSH_BODY_MAX);
    expect(parsed.title.endsWith("…")).toBe(true);
  });

  it("flattens newlines, which a lock screen would swallow anyway", () => {
    const parsed = JSON.parse(
      buildPushPayload({ title: "Quote\n\nsent", body: "line\nline" })
    );
    expect(parsed.title).toBe("Quote sent");
    expect(parsed.body).toBe("line line");
  });
});

describe("isDeadSubscriptionStatus", () => {
  it("treats 404 and 410 as gone for good", () => {
    expect(isDeadSubscriptionStatus(404)).toBe(true);
    expect(isDeadSubscriptionStatus(410)).toBe(true);
  });

  // Deleting on a transient failure would silently unsubscribe somebody
  // because a push service had a bad minute.
  it.each([null, undefined, 429, 500, 502, 401])(
    "keeps the row on %s",
    (status) => {
      expect(isDeadSubscriptionStatus(status as number | null)).toBe(false);
    }
  );
});

describe("deliverPush", () => {
  it("sends to every device and reports how many landed", async () => {
    const seen: string[] = [];
    const result = await deliverPush(
      [sub("a"), sub("b"), sub("c")],
      { title: "New message" },
      async (s) => {
        seen.push(s.id);
        return { ok: true };
      }
    );
    expect(seen.sort()).toEqual(["a", "b", "c"]);
    expect(result.sent).toBe(3);
    expect(result.dead).toEqual([]);
  });

  it("hands back only the 410/404 rows for deletion", async () => {
    const result = await deliverPush(
      [sub("live"), sub("gone"), sub("hiccup")],
      { title: "x" },
      async (s) => {
        if (s.id === "gone") return { ok: false, status: 410 };
        if (s.id === "hiccup") return { ok: false, status: 500 };
        return { ok: true };
      }
    );
    expect(result.sent).toBe(1);
    expect(result.dead).toEqual(["gone"]);
  });

  it("treats a thrown deliverer as transient, never as a reason to delete", async () => {
    const result = await deliverPush([sub("a")], { title: "x" }, async () => {
      throw new Error("network down");
    });
    expect(result.sent).toBe(0);
    expect(result.dead).toEqual([]);
  });

  it("gives every device the same payload", async () => {
    const payloads: string[] = [];
    await deliverPush(
      [sub("a"), sub("b")],
      { title: "New quote", url: "/chats?lead=1" },
      async (_s, payload) => {
        payloads.push(payload);
        return { ok: true };
      }
    );
    expect(payloads[0]).toBe(payloads[1]);
    expect(JSON.parse(payloads[0]).title).toBe("New quote");
  });
});

describe("pushConfigured", () => {
  it("needs all three keys", () => {
    expect(
      pushConfigured({
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub",
        VAPID_PRIVATE_KEY: "priv",
        VAPID_SUBJECT: "mailto:a@b.c",
      })
    ).toBe(true);
  });

  // The dormant state: this is what makes push a silent no-op before the keys
  // reach Vercel, exactly like email without RESEND_API_KEY.
  it.each([
    {},
    { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub" },
    { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" },
    { NEXT_PUBLIC_VAPID_PUBLIC_KEY: " ", VAPID_PRIVATE_KEY: "p", VAPID_SUBJECT: "s" },
  ])("is not configured with %o", (env) => {
    expect(pushConfigured(env)).toBe(false);
  });
});
