import { describe, it, expect } from "vitest";
import {
  isPlusGatedKind,
  isPushHeldForQuietHours,
  isPushKind,
  shouldSendOutboundChannels,
  PLUS_GATED_NOTIFICATION_KINDS,
  PUSH_NOTIFICATION_KINDS,
} from "./notifyGating";

// The proactive homeowner alerts and reminders - the ones Hearth generates on
// its own schedule. Email/SMS on these is what Hearth Plus sells.
const GATED = [
  "freeze",
  "heat",
  "high_wind",
  "heavy_rain",
  "maintenance_upcoming",
  "maintenance_overdue",
  "filter_reminder",
  "seasonal_check",
  "insurance_renewal",
  "home_digest",
];

// Every other kind sendNotification is called with anywhere in the app,
// harvested from the callers. If a new kind lands here it should be a
// deliberate decision, not a default.
const UNGATED = [
  // homeowner transactional
  "quote_analysis",
  "quote_sent",
  "invoice_sent",
  "new_review",
  "review_request",
  "job_closed",
  "applicant_waiting",
  "direct_request",
  // billing / legal notices, on either side of the marketplace
  "renewal_reminder",
  "annual_notice",
  "renewal_acknowledgment",
  // pro side
  "new_lead",
  "apply_receipt",
  "apply_credit_back",
  "direct_accepted",
  "direct_declined",
  "aging_deal",
  "weekly_digest",
  "winback_credit",
  "first_apply_guarantee",
  "ghost_refund",
  "referral_reward",
];

describe("isPlusGatedKind", () => {
  it.each(GATED)("gates the proactive homeowner kind %s", (kind) => {
    expect(isPlusGatedKind(kind)).toBe(true);
  });

  it.each(UNGATED)("leaves %s ungated", (kind) => {
    expect(isPlusGatedKind(kind)).toBe(false);
  });

  it("does not gate an unrecognized kind", () => {
    // A kind nobody classified must keep working like every other
    // transactional message; the gate opts kinds IN, never out.
    expect(isPlusGatedKind("some_future_kind")).toBe(false);
  });

  it("never gates a billing or auto-renewal notice", () => {
    for (const kind of ["renewal_reminder", "annual_notice", "renewal_acknowledgment"]) {
      expect(PLUS_GATED_NOTIFICATION_KINDS.has(kind)).toBe(false);
    }
  });
});

describe("shouldSendOutboundChannels", () => {
  it("sends an ungated kind on every channel regardless of membership", () => {
    for (const status of ["plus", "free", "unknown"] as const) {
      expect(shouldSendOutboundChannels("quote_sent", status)).toBe(true);
    }
  });

  it("sends a gated kind to a member", () => {
    expect(shouldSendOutboundChannels("filter_reminder", "plus")).toBe(true);
  });

  it("withholds a gated kind from a confirmed non-member", () => {
    expect(shouldSendOutboundChannels("filter_reminder", "free")).toBe(false);
  });

  it("FAILS CLOSED on a failed membership lookup", () => {
    // This is a paid gate: an outage must not hand out the perk. The in-app
    // notification row is written by sendNotification either way.
    expect(shouldSendOutboundChannels("filter_reminder", "unknown")).toBe(false);
    expect(shouldSendOutboundChannels("home_digest", "unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Web push routing
// ---------------------------------------------------------------------------

describe("isPushKind", () => {
  // Something a PERSON just did that the recipient is waiting on. These are
  // what the owner asked for: "notified when a person requests a quote, sends
  // a message to them".
  it.each([
    "message",
    "direct_request",
    "direct_accepted",
    "direct_declined",
    "quote",
    "quote_sent",
    "invoice",
    "invoice_sent",
    "invoice_signed",
    "new_lead",
    "job_closed",
    "new_review",
    "review_request",
  ])("buzzes the phone for %s", (kind) => {
    expect(isPushKind(kind)).toBe(true);
  });

  // Safety and weather: time-critical by definition, so they push even though
  // nobody asked for them just now. Quiet hours cover the 3am case separately.
  it.each(["freeze", "heat", "high_wind", "heavy_rain", "recall"])(
    "buzzes the phone for the safety alert %s",
    (kind) => {
      expect(isPushKind(kind)).toBe(true);
    }
  );

  // Digests, reminders, billing notices and internal bookkeeping. None of them
  // is worth waking a phone for.
  it.each([
    "home_digest",
    "weekly_digest",
    "support_digest",
    "maintenance_upcoming",
    "maintenance_overdue",
    "filter_reminder",
    "seasonal_check",
    "insurance_renewal",
    "renewal_reminder",
    "annual_notice",
    "renewal_acknowledgment",
    "referral_reward",
    "winback_credit",
    "first_apply_guarantee",
    "apply_receipt",
    "apply_credit_back",
    "aging_deal",
    "applicant_waiting",
    "ghost_refund",
    "trial_abuse",
  ])("stays silent for %s", (kind) => {
    expect(isPushKind(kind)).toBe(false);
  });

  // An ALLOWLIST, and this is the assertion that keeps it one: a push
  // interrupts somebody, so a kind nobody has classified must default to
  // silence rather than to a buzz.
  it("stays silent for an unrecognized kind", () => {
    expect(isPushKind("some_future_kind")).toBe(false);
  });

  it("is free for everyone: the Plus gate and the push list are independent", () => {
    // The weather alerts are Plus-gated on email/SMS and still push, which is
    // the whole point - push costs nothing to send, so there is no bill to
    // gate behind a subscription.
    for (const kind of ["freeze", "heat", "high_wind", "heavy_rain"]) {
      expect(PLUS_GATED_NOTIFICATION_KINDS.has(kind)).toBe(true);
      expect(PUSH_NOTIFICATION_KINDS.has(kind)).toBe(true);
    }
  });
});

describe("isPushHeldForQuietHours", () => {
  // A cron-generated alert at 3am is a buzz nobody asked for at an hour nobody
  // wants.
  it.each([0, 3, 7, 21, 22, 23])("holds a weather alert at %i:00", (hour) => {
    expect(isPushHeldForQuietHours("freeze", hour)).toBe(true);
  });

  it.each([8, 12, 20])("lets a weather alert through at %i:00", (hour) => {
    expect(isPushHeldForQuietHours("freeze", hour)).toBe(false);
  });

  // The rule deliberately does NOT copy the SMS quiet hours wholesale: holding
  // a message at 9:05pm would mean building push notifications that do not
  // notify, which is the exact complaint this was built to fix.
  it.each([0, 3, 22, 23])(
    "never holds a message from a real person, even at %i:00",
    (hour) => {
      expect(isPushHeldForQuietHours("message", hour)).toBe(false);
      expect(isPushHeldForQuietHours("direct_request", hour)).toBe(false);
      expect(isPushHeldForQuietHours("new_lead", hour)).toBe(false);
    }
  );

  it("holds rather than guesses when the hour is unreadable", () => {
    expect(isPushHeldForQuietHours("freeze", Number.NaN)).toBe(true);
  });
});
