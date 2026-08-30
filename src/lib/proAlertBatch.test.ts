import { describe, it, expect } from "vitest";
import {
  buildAlertOutbound,
  buildAlertNotificationRows,
  nextCollapsedAlertTitle,
  collapsedAlertBody,
  planAlertFanout,
  type AlertRecipientRow,
} from "./proAlertBatch";

// These helpers carry the per-recipient semantics the batched job-post fan-out
// has to keep identical to sendNotification's single-recipient path. The rules
// under test, restated from src/lib/notify.ts:
//   - externalChannels false means no contact details leave this module at all,
//     which is how email/SMS are held back without the fan-out knowing anything
//     about Resend or Twilio.
//   - contractors.contact_phone wins over users.phone (onboarding writes the
//     former and never the latter).
//   - sms_consent must be exactly true; anything else is no consent on file.
//   - a recipient with neither an email nor a phone has nothing to send on.
//   - a missing users row means "unknown", not "opted out".

const PAYLOAD = {
  kind: "new_lead",
  title: "New plumbing job just posted",
  body: "Timing: this week.",
  url: "/pro",
};

function rows(
  entries: [string, AlertRecipientRow][]
): Map<string, AlertRecipientRow> {
  return new Map(entries);
}

describe("buildAlertOutbound", () => {
  it("returns nothing when externalChannels is off, whatever contacts exist", () => {
    const out = buildAlertOutbound(["u1", "u2"], {
      externalChannels: false,
      rowByUser: rows([
        ["u1", { email: "a@example.com", phone: "+15551112222", sms_consent: true }],
        ["u2", { email: "b@example.com" }],
      ]),
      contactPhoneByUser: new Map([["u1", "+15559998888"]]),
    });
    expect(out).toEqual([]);
  });

  it("prefers the contractor contact_phone over users.phone", () => {
    const [r] = buildAlertOutbound(["u1"], {
      externalChannels: true,
      rowByUser: rows([["u1", { email: null, phone: "+15551112222" }]]),
      contactPhoneByUser: new Map([["u1", "+15559998888"]]),
    });
    expect(r.phone).toBe("+15559998888");
  });

  it("falls back to users.phone when the contractor has no contact_phone", () => {
    const [r] = buildAlertOutbound(["u1"], {
      externalChannels: true,
      rowByUser: rows([["u1", { phone: "+15551112222" }]]),
      contactPhoneByUser: new Map(),
    });
    expect(r.phone).toBe("+15551112222");
  });

  it("treats anything but a literal true as no SMS consent", () => {
    const rowByUser = rows([
      ["yes", { phone: "+1", sms_consent: true }],
      ["no", { phone: "+1", sms_consent: false }],
      ["null", { phone: "+1", sms_consent: null }],
      ["absent", { phone: "+1" }],
    ]);
    const out = buildAlertOutbound(["yes", "no", "null", "absent"], {
      externalChannels: true,
      rowByUser,
      contactPhoneByUser: new Map(),
    });
    expect(out.map((r) => [r.userId, r.smsConsent])).toEqual([
      ["yes", true],
      ["no", false],
      ["null", false],
      ["absent", false],
    ]);
  });

  it("drops recipients with no email and no phone", () => {
    const out = buildAlertOutbound(["has-email", "has-phone", "has-neither"], {
      externalChannels: true,
      rowByUser: rows([
        ["has-email", { email: "a@example.com", phone: null }],
        ["has-phone", { email: null, phone: "+15551112222" }],
        ["has-neither", { email: null, phone: null }],
      ]),
      contactPhoneByUser: new Map(),
    });
    expect(out.map((r) => r.userId)).toEqual(["has-email", "has-phone"]);
  });

  it("reads the CAN-SPAM opt-out off the batched prefs, and only on a literal true", () => {
    const out = buildAlertOutbound(["out", "in", "empty-prefs"], {
      externalChannels: true,
      rowByUser: rows([
        [
          "out",
          { email: "a@example.com", notification_prefs: { email_opt_out: true } },
        ],
        [
          "in",
          { email: "b@example.com", notification_prefs: { email_opt_out: false } },
        ],
        ["empty-prefs", { email: "c@example.com", notification_prefs: null }],
      ]),
      contactPhoneByUser: new Map(),
    });
    expect(out.map((r) => [r.userId, r.emailOptOut])).toEqual([
      ["out", true],
      ["in", false],
      ["empty-prefs", false],
    ]);
  });

  it("reports an unknown opt-out (not an opt-in) when the users row is missing", () => {
    // A pro whose users row didn't come back still has a phone from the
    // contractors table, so there is something to send. sendEmail must fall
    // open on unknown, the same as when its own lookup fails, so the flag has
    // to be undefined rather than false.
    const [r] = buildAlertOutbound(["ghost"], {
      externalChannels: true,
      rowByUser: new Map(),
      contactPhoneByUser: new Map([["ghost", "+15559998888"]]),
    });
    expect(r.emailOptOut).toBeUndefined();
    expect(r.email).toBeNull();
    expect(r.phone).toBe("+15559998888");
  });
});

describe("buildAlertNotificationRows", () => {
  it("writes one identical row per target, keyed by user", () => {
    expect(buildAlertNotificationRows(["u1", "u2"], PAYLOAD)).toEqual([
      { user_id: "u1", kind: "new_lead", title: PAYLOAD.title, body: PAYLOAD.body, url: "/pro" },
      { user_id: "u2", kind: "new_lead", title: PAYLOAD.title, body: PAYLOAD.body, url: "/pro" },
    ]);
  });

  it("normalizes a missing body and url to null, like the single-row insert", () => {
    const [row] = buildAlertNotificationRows(["u1"], {
      kind: "new_lead",
      title: "New job",
    });
    expect(row.body).toBeNull();
    expect(row.url).toBeNull();
  });

  it("produces no rows for no targets, so an empty fan-out inserts nothing", () => {
    expect(buildAlertNotificationRows([], PAYLOAD)).toEqual([]);
  });
});

// CR5#6: same-pro alerts posted close together collapse into one message.
describe("nextCollapsedAlertTitle", () => {
  it("turns a single-job title into the first collapsed count", () => {
    expect(nextCollapsedAlertTitle("New plumbing job just posted")).toBe(
      "2 new jobs in your trades"
    );
  });

  it("increments an already-collapsed title", () => {
    expect(nextCollapsedAlertTitle("2 new jobs in your trades")).toBe(
      "3 new jobs in your trades"
    );
    expect(nextCollapsedAlertTitle("9 new jobs in your trades")).toBe(
      "10 new jobs in your trades"
    );
  });

  it("tolerates stray whitespace on the stored title", () => {
    expect(nextCollapsedAlertTitle("  2 new jobs in your trades  ")).toBe(
      "3 new jobs in your trades"
    );
  });
});

describe("collapsedAlertBody", () => {
  it("matches the count in the title it was built from", () => {
    expect(collapsedAlertBody("3 new jobs in your trades")).toBe(
      "3 new jobs just posted in your trades. Check the board to apply."
    );
  });

  it("falls back to a plain word if the title shape is unexpected", () => {
    expect(collapsedAlertBody("New plumbing job just posted")).toBe(
      "Multiple new jobs just posted in your trades. Check the board to apply."
    );
  });
});

describe("planAlertFanout", () => {
  it("sends every target with no recent row to the fresh-insert group", () => {
    const plan = planAlertFanout(["u1", "u2"], new Map());
    expect(plan.freshTargets).toEqual(["u1", "u2"]);
    expect(plan.collapsedUpdates).toEqual([]);
  });

  it("routes a target with a recent row to a collapsed update instead", () => {
    const plan = planAlertFanout(
      ["u1", "u2"],
      new Map([["u1", "New plumbing job just posted"]])
    );
    expect(plan.freshTargets).toEqual(["u2"]);
    expect(plan.collapsedUpdates).toEqual([
      {
        userId: "u1",
        title: "2 new jobs in your trades",
        body: "2 new jobs just posted in your trades. Check the board to apply.",
      },
    ]);
  });

  it("keeps incrementing a pro who is alerted a third time inside the window", () => {
    const plan = planAlertFanout(
      ["u1"],
      new Map([["u1", "2 new jobs in your trades"]])
    );
    expect(plan.collapsedUpdates[0].title).toBe("3 new jobs in your trades");
  });
});
