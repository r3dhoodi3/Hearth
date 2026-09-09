import { describe, it, expect, vi, beforeEach } from "vitest";

// The bug-report action, with the database mocked out. C7 (2026-09-07): the
// action no longer grants any credit itself - every report is stored
// pending review, and money moves only through verify_pro_feedback (0157),
// run by hand outside the app. What is proved here: validation, the rate
// limit, and that a stored report always comes back as "pending", with no
// wallet call anywhere in the path.

const insertProFeedback = vi.fn();
const proFeedbackRateLimitOk = vi.fn();
const getCurrentContractor = vi.fn();

vi.mock("@/lib/proFeedbackServer", () => ({
  insertProFeedback: (...a: unknown[]) => insertProFeedback(...a),
  proFeedbackRateLimitOk: (...a: unknown[]) => proFeedbackRateLimitOk(...a),
}));
vi.mock("@/lib/contractor", () => ({
  getCurrentContractor: (...a: unknown[]) => getCurrentContractor(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { submitProFeedbackAction } from "./actions";
import { FEEDBACK_ERROR_COPY, FEEDBACK_MIN_MESSAGE } from "@/lib/proFeedback";

const GOOD = "The apply flow is great but the wallet page is confusing.";

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentContractor.mockResolvedValue({ id: "c1", user_id: "u1" });
  insertProFeedback.mockResolvedValue("ok");
  proFeedbackRateLimitOk.mockResolvedValue(true);
});

describe("submitProFeedbackAction: stores, never pays", () => {
  it("stores the report and returns 'pending', no matter who the pro is", async () => {
    const res = await submitProFeedbackAction({
      score: 4,
      message: GOOD,
      contactOk: true,
    });
    expect(res).toEqual({ ok: true, data: { outcome: "pending" } });
    expect(insertProFeedback).toHaveBeenCalledTimes(1);
    expect(insertProFeedback).toHaveBeenCalledWith({
      contractorId: "c1",
      userId: "u1",
      score: 4,
      message: GOOD,
      contactOk: true,
    });
  });

  it("returns 'pending' again for a second report from the same business", async () => {
    // Since migration 0152 a business can send any number of reports; none of
    // them pay automatically, so the outcome never changes.
    const res = await submitProFeedbackAction({
      score: 2,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: true, data: { outcome: "pending" } });
  });
});

describe("submitProFeedbackAction: refusals", () => {
  it("refuses a score outside 1..5 before touching the database", async () => {
    const res = await submitProFeedbackAction({
      score: 9,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.score });
    expect(insertProFeedback).not.toHaveBeenCalled();
  });

  it("refuses a note under the stated floor", async () => {
    const res = await submitProFeedbackAction({
      score: 3,
      message: "x".repeat(FEEDBACK_MIN_MESSAGE - 1),
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.message_short });
    expect(insertProFeedback).not.toHaveBeenCalled();
  });

  it("refuses when the rate limit says no, before storing anything", async () => {
    proFeedbackRateLimitOk.mockResolvedValue(false);
    const res = await submitProFeedbackAction({
      score: 3,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({
      ok: false,
      error: FEEDBACK_ERROR_COPY.rate_limited,
    });
    expect(insertProFeedback).not.toHaveBeenCalled();
  });

  it("relays 'failed' when the store itself failed", async () => {
    insertProFeedback.mockResolvedValue("failed");
    const res = await submitProFeedbackAction({
      score: 3,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.failed });
  });

  it("relays 'already' while the live database still caps one row per business", async () => {
    // Only the pre-0152 window: the unique index refused the row, so the note
    // was NOT stored.
    insertProFeedback.mockResolvedValue("already");
    const res = await submitProFeedbackAction({
      score: 5,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.already });
  });

  it("refuses an account with no company row", async () => {
    getCurrentContractor.mockResolvedValue(null);
    const res = await submitProFeedbackAction({
      score: 3,
      message: GOOD,
      contactOk: false,
    });
    expect(res.ok).toBe(false);
    expect(insertProFeedback).not.toHaveBeenCalled();
  });
});
