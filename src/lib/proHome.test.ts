import { describe, it, expect } from "vitest";
import {
  buildSetupItems,
  daysUntil,
  expiryChips,
  greetingForHour,
  homeSubtitle,
  EXPIRY_WARN_DAYS,
} from "@/lib/proHome";
import { PRO_LEADS_HREF } from "@/lib/constants";

// The pure half of the pro Home tab. No database, so every sentence and every
// checklist rule is testable on its own.

describe("greetingForHour", () => {
  it("says morning, afternoon, evening at the right hours", () => {
    expect(greetingForHour(0)).toBe("Good morning");
    expect(greetingForHour(11)).toBe("Good morning");
    expect(greetingForHour(12)).toBe("Good afternoon");
    expect(greetingForHour(17)).toBe("Good afternoon");
    expect(greetingForHour(18)).toBe("Good evening");
    expect(greetingForHour(23)).toBe("Good evening");
  });
});

describe("homeSubtitle", () => {
  it("says nothing is waiting when nothing is", () => {
    expect(
      homeSubtitle({ openJobs: 0, awaitingReply: 0, directRequests: 0 })
    ).toBe("Nothing waiting on you right now.");
  });

  it("counts each thing once, in plain words", () => {
    expect(
      homeSubtitle({ openJobs: 2, awaitingReply: 1, directRequests: 0 })
    ).toBe("2 new jobs in your trades, 1 homeowner waiting on your reply.");
  });

  it("gets its singulars right", () => {
    expect(
      homeSubtitle({ openJobs: 1, awaitingReply: 0, directRequests: 1 })
    ).toBe("1 homeowner asked for you, 1 new job in your trades.");
  });

  it("leads with the exclusive thing", () => {
    // A direct request is only visible to this pro, so it comes first.
    const s = homeSubtitle({
      openJobs: 5,
      awaitingReply: 3,
      directRequests: 2,
    });
    expect(s.indexOf("asked for you")).toBeLessThan(s.indexOf("new jobs"));
  });

  it("never invents urgency", () => {
    const s = homeSubtitle({ openJobs: 9, awaitingReply: 9, directRequests: 9 });
    expect(s).not.toContain("!");
    expect(s.toLowerCase()).not.toContain("hurry");
    expect(s.toLowerCase()).not.toContain("now");
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-08-29T18:00:00Z");

  it("returns null with no date on file", () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil(undefined, now)).toBeNull();
    expect(daysUntil("not a date", now)).toBeNull();
  });

  it("counts whole days, ignoring the time of day", () => {
    expect(daysUntil("2026-08-29", now)).toBe(0);
    expect(daysUntil("2026-09-05", now)).toBe(7);
    expect(daysUntil("2026-08-22", now)).toBe(-7);
  });
});

describe("expiryChips", () => {
  const now = new Date("2026-08-29T18:00:00Z");

  it("says nothing when nothing is close", () => {
    expect(
      expiryChips({ license_expires: "2027-01-01", insurance_expires: null }, now)
    ).toEqual([]);
  });

  it("says nothing at all when no dates are on file", () => {
    expect(expiryChips({}, now)).toEqual([]);
  });

  it("warns inside the window and not a day outside it", () => {
    const inside = new Date(now.getTime() + 0);
    const at = new Date(
      Date.UTC(2026, 7, 29) + EXPIRY_WARN_DAYS * 86_400_000
    );
    const iso = at.toISOString().slice(0, 10);
    expect(expiryChips({ license_expires: iso }, inside)).toHaveLength(1);
    const beyond = new Date(at.getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(expiryChips({ license_expires: beyond }, inside)).toEqual([]);
  });

  it("marks an already-lapsed date as overdue and says so plainly", () => {
    const [chip] = expiryChips({ insurance_expires: "2026-08-01" }, now);
    expect(chip.overdue).toBe(true);
    expect(chip.label).toBe("Insurance expired");
  });

  it("counts down in days and links where the date is edited", () => {
    const [chip] = expiryChips({ license_expires: "2026-09-05" }, now);
    expect(chip.label).toBe("License expires in 7 days");
    expect(chip.overdue).toBe(false);
    expect(chip.href).toBe("/pro/business#account");
  });

  it("handles the singular and today", () => {
    expect(expiryChips({ license_expires: "2026-08-30" }, now)[0].label).toBe(
      "License expires in 1 day"
    );
    expect(expiryChips({ license_expires: "2026-08-29" }, now)[0].label).toBe(
      "License expires today"
    );
  });
});

describe("buildSetupItems", () => {
  const base = {
    name: "Jamie's Roofing",
    categories: ["roofing"],
    license_number: null,
    license_verified_status: null,
    yelp_url: null,
    google_reviews_url: null,
    logo_url: null,
  };

  it("sends 'Apply to your first job' to the board, not to whatever page is showing", () => {
    // The board is a route of its own now, so a bare "#open-jobs" would land
    // on nothing when the checklist renders on Home.
    const items = buildSetupItems({
      contractor: base,
      balanceCents: 0,
      applicationCount: 0,
      canUploadLogo: true,
    });
    const apply = items.find((i) => i.label === "Apply to your first job");
    expect(apply?.href).toBe(`${PRO_LEADS_HREF}#open-jobs`);
  });

  it("only ticks the license once the CSLB has confirmed it", () => {
    const failed = buildSetupItems({
      contractor: {
        ...base,
        license_number: "123456",
        license_verified_status: "failed",
      },
      balanceCents: 0,
      applicationCount: 0,
      canUploadLogo: true,
    })[1];
    expect(failed.done).toBe(false);
    expect(failed.label).toBe("License not confirmed");

    const verified = buildSetupItems({
      contractor: {
        ...base,
        license_number: "123456",
        license_verified_status: "verified",
      },
      balanceCents: 0,
      applicationCount: 0,
      canUploadLogo: true,
    })[1];
    expect(verified.done).toBe(true);
  });

  it("marks a pending check optional so it cannot pin the card open forever", () => {
    const pending = buildSetupItems({
      contractor: {
        ...base,
        license_number: "123456",
        license_verified_status: "pending",
      },
      balanceCents: 0,
      applicationCount: 0,
      canUploadLogo: true,
    })[1];
    expect(pending.optional).toBe(true);
  });

  it("marks the logo optional for a non-member and points at the pitch", () => {
    const logo = buildSetupItems({
      contractor: base,
      balanceCents: 0,
      applicationCount: 0,
      canUploadLogo: false,
    })[3];
    expect(logo.optional).toBe(true);
    expect(logo.href).toBe("/pro/plus?reason=logo");
  });

  it("ticks the wallet step off any positive balance", () => {
    const items = buildSetupItems({
      contractor: base,
      balanceCents: 1,
      applicationCount: 0,
      canUploadLogo: true,
    });
    expect(items.find((i) => i.label === "Fund your wallet")?.done).toBe(true);
  });
});
