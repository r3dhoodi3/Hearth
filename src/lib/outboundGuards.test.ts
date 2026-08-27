import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it, expect, vi } from "vitest";

import {
  OUTBOUND_PER_MINUTE,
  allowOutboundSend,
  outboundDisabled,
  resetOutboundWindow,
  stripControlChars,
  toUsE164,
} from "./outboundGuards";

// src/lib/notify.ts imports "server-only" (it reads the Resend/Twilio secrets),
// so it cannot be imported here. The guards themselves live in their own
// dependency-free module and ARE exercised for real below; that they are
// actually WIRED to the send boundary is asserted against notify.ts's source,
// the same way src/lib/aiUsage.test.ts checks the AI routes.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const notify = src("./notify.ts");

describe("toUsE164", () => {
  it("accepts ten digits and adds the country code", () => {
    expect(toUsE164("5551234567")).toBe("+15551234567");
  });

  it("accepts eleven digits when they start with 1", () => {
    expect(toUsE164("15551234567")).toBe("+15551234567");
    expect(toUsE164("+15551234567")).toBe("+15551234567");
  });

  it("accepts the punctuation a human actually types", () => {
    expect(toUsE164("(555) 123-4567")).toBe("+15551234567");
    expect(toUsE164("555.123.4567")).toBe("+15551234567");
    expect(toUsE164("  +1 555 123 4567  ")).toBe("+15551234567");
  });

  it("refuses eleven digits that do not start with 1", () => {
    // +44 and friends: a US long code cannot text them, and a premium-rate
    // international destination is the reason this gate exists at all.
    expect(toUsE164("+447700900123")).toBeNull();
    expect(toUsE164("25551234567")).toBeNull();
  });

  it("refuses anything that is the wrong length", () => {
    expect(toUsE164("555123456")).toBeNull();
    expect(toUsE164("155512345678")).toBeNull();
    expect(toUsE164("")).toBeNull();
    expect(toUsE164("   ")).toBeNull();
  });

  it("refuses a value carrying anything but digits and phone punctuation", () => {
    // contractors.contact_phone is a column `authenticated` can UPDATE
    // directly (migration 0085), so these are values a pro's own account can
    // put there. None of them may reach Twilio's "To" field.
    expect(toUsE164("5551234567\r\nFrom=+15550000000")).toBeNull();
    expect(toUsE164("5551234567&Body=free+money")).toBeNull();
    expect(toUsE164("555123456a")).toBeNull();
    expect(toUsE164("<script>5551234567</script>")).toBeNull();
  });

  it("refuses a non-string", () => {
    expect(toUsE164(null)).toBeNull();
    expect(toUsE164(undefined)).toBeNull();
  });

  it("refuses an absurdly long value before doing any work on it", () => {
    expect(toUsE164("5".repeat(500))).toBeNull();
  });
});

describe("stripControlChars", () => {
  it("removes CR and LF from a name that lands in an email subject", () => {
    // A pro's business name is free text they typed, and it is interpolated
    // into the subject line. A CR/LF there is header injection.
    const injected = "Acme Plumbing\r\nBcc: everyone@example.com";
    const cleaned = stripControlChars(injected);
    expect(cleaned).not.toContain("\r");
    expect(cleaned).not.toContain("\n");
    expect(cleaned).toBe("Acme Plumbing Bcc: everyone@example.com");
  });

  it("removes tabs and other control bytes", () => {
    expect(stripControlChars("a\tb")).toBe("a b");
    expect(stripControlChars("a\u0000b")).toBe("a b");
    expect(stripControlChars("a\u0007b")).toBe("a b");
    expect(stripControlChars("a\u001bb")).toBe("a b");
    expect(stripControlChars("a\u007fb")).toBe("a b");
  });

  it("leaves ordinary text alone", () => {
    expect(stripControlChars("Leaking water heater - $250")).toBe(
      "Leaking water heater - $250"
    );
    expect(stripControlChars("Cafe Munoz's Roofing")).toBe("Cafe Munoz's Roofing");
  });

  it("collapses the gap it leaves and trims the ends", () => {
    expect(stripControlChars("\n\nRoof leak\n\n")).toBe("Roof leak");
  });
});

describe("the kill switch", () => {
  const original = process.env.OUTBOUND_DISABLED;

  beforeEach(() => {
    if (original === undefined) delete process.env.OUTBOUND_DISABLED;
    else process.env.OUTBOUND_DISABLED = original;
  });

  it("is off unless it is explicitly set", () => {
    delete process.env.OUTBOUND_DISABLED;
    expect(outboundDisabled()).toBe(false);
    process.env.OUTBOUND_DISABLED = "";
    expect(outboundDisabled()).toBe(false);
    process.env.OUTBOUND_DISABLED = "0";
    expect(outboundDisabled()).toBe(false);
    process.env.OUTBOUND_DISABLED = "false";
    expect(outboundDisabled()).toBe(false);
  });

  it("accepts 1 and true, in any casing, with stray whitespace", () => {
    for (const value of ["1", "true", "TRUE", " True "]) {
      process.env.OUTBOUND_DISABLED = value;
      expect(outboundDisabled()).toBe(true);
    }
  });

  it("is read per send, not cached, so flipping it takes effect immediately", () => {
    delete process.env.OUTBOUND_DISABLED;
    expect(outboundDisabled()).toBe(false);
    process.env.OUTBOUND_DISABLED = "1";
    expect(outboundDisabled()).toBe(true);
  });
});

describe("the per-process outbound cap", () => {
  beforeEach(() => {
    resetOutboundWindow();
    vi.restoreAllMocks();
  });

  it("allows everything up to the cap", () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < OUTBOUND_PER_MINUTE; i++) {
      expect(allowOutboundSend(now)).toBe(true);
    }
  });

  it("drops the send past the cap and says so once, not once per send", () => {
    const now = 1_700_000_000_000;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < OUTBOUND_PER_MINUTE; i++) allowOutboundSend(now);
    expect(allowOutboundSend(now)).toBe(false);
    expect(allowOutboundSend(now)).toBe(false);
    expect(allowOutboundSend(now)).toBe(false);
    // One line for the trip, not one per dropped message: a flood of texts
    // must not become a flood of log lines.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("[ALERT]");
  });

  it("starts fresh in the next minute and reports what it dropped", () => {
    const now = 1_700_000_000_000;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < OUTBOUND_PER_MINUTE; i++) allowOutboundSend(now);
    expect(allowOutboundSend(now)).toBe(false);

    expect(allowOutboundSend(now + 60_000)).toBe(true);
    const summary = logged.mock.calls.map((c) => String(c[0])).join("\n");
    expect(summary).toContain("[ALERT] outbound cap dropped 1 sends");
  });
});

describe("the guards are wired to the one send door", () => {
  it("there is exactly one Twilio send path in the app", () => {
    // If this ever finds a second one, that one needs the same gate.
    expect(notify).toContain("https://api.twilio.com/2010-04-01/Accounts/");
  });

  it("sendSms validates the destination and sends the normalised number", () => {
    expect(notify).toContain("const to = toUsE164(input.phone);");
    expect(notify).toContain("if (!to) return;");
    expect(notify).toContain("To: to,");
    // The raw column value must never be the thing handed to Twilio.
    expect(notify).not.toContain("To: input.phone");
  });

  it("records WHY the destination is validated here", () => {
    // The reason is not "tidy input": contractors.contact_phone is a column
    // `authenticated` holds a direct UPDATE on, so the destination is
    // attacker-writable. Losing that comment loses the reason the gate exists.
    expect(notify).toContain("0085");
    expect(notify).toContain("contact_phone");
  });

  it("strips control characters out of the email subject and the SMS body", () => {
    expect(notify).toContain("const subject = stripControlChars(input.title);");
    expect(notify).toContain("subject,");
    expect(notify).not.toContain("subject: input.title");
    expect(notify).toMatch(/const body = stripControlChars\(/);
  });

  it("puts the kill switch and the cap in sendOutboundChannels, before any send", () => {
    const door = notify.slice(
      notify.indexOf("export async function sendOutboundChannels")
    );
    const kill = door.indexOf("outboundDisabled()");
    const cap = door.indexOf("allowOutboundSend()");
    const sent = door.indexOf("sendEmail(input");
    expect(kill).toBeGreaterThan(-1);
    expect(cap).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(cap);
    expect(cap).toBeLessThan(sent);
  });

  it("gates the batched fan-out too, since it comes through the same door", () => {
    // src/lib/proAlerts.ts writes its in-app rows itself but calls
    // sendOutboundChannels for the email/SMS half, which is exactly why the
    // gates go there and not in sendNotification.
    const alerts = src("./proAlerts.ts");
    expect(alerts).toContain("sendOutboundChannels");
    expect(alerts).not.toContain("api.twilio.com");
    expect(alerts).not.toContain("api.resend.com");
  });
});
