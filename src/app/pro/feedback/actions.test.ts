import { describe, it, expect, vi, beforeEach } from "vitest";

// The feedback action, with the database mocked out. The SQL function's own
// idempotency cannot run here (there is no Postgres in vitest, see
// src/lib/proFeedback.test.ts for the assertions that cover its shape), so
// what is proved here is everything the ACTION is responsible for: validation,
// the established-pro gate, and that a second submit stores nothing and grants
// nothing.

const insertProFeedback = vi.fn();
const grantFeedbackCredit = vi.fn();
const getCurrentContractor = vi.fn();
const isEstablishedPro = vi.fn();

vi.mock("@/lib/proFeedbackServer", () => ({
  insertProFeedback: (...a: unknown[]) => insertProFeedback(...a),
  grantFeedbackCredit: (...a: unknown[]) => grantFeedbackCredit(...a),
  readFeedbackState: vi.fn(),
}));
vi.mock("@/lib/contractor", () => ({
  getCurrentContractor: (...a: unknown[]) => getCurrentContractor(...a),
  isEstablishedPro: (...a: unknown[]) => isEstablishedPro(...a),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { submitProFeedbackAction } from "./actions";
import { FEEDBACK_ERROR_COPY, FEEDBACK_MIN_MESSAGE } from "@/lib/proFeedback";

const GOOD = "The apply flow is great but the wallet page is confusing.";

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentContractor.mockResolvedValue({ id: "c1", user_id: "u1" });
  isEstablishedPro.mockResolvedValue(true);
  insertProFeedback.mockResolvedValue("ok");
  grantFeedbackCredit.mockResolvedValue(true);
});

describe("submitProFeedbackAction", () => {
  it("stores the note and grants the credit for an established pro", async () => {
    const res = await submitProFeedbackAction({
      score: 4,
      message: GOOD,
      contactOk: true,
    });
    expect(res).toEqual({ ok: true, data: { granted: true } });
    expect(insertProFeedback).toHaveBeenCalledTimes(1);
    expect(insertProFeedback).toHaveBeenCalledWith({
      contractorId: "c1",
      userId: "u1",
      score: 4,
      message: GOOD,
      contactOk: true,
    });
    expect(grantFeedbackCredit).toHaveBeenCalledWith("c1");
  });

  it("stores the note but grants nothing for a pro who is not established yet", async () => {
    // Their words still reach us; the money does not, or a throwaway signup
    // plus twenty characters is a $5 vending machine.
    isEstablishedPro.mockResolvedValue(false);
    const res = await submitProFeedbackAction({
      score: 2,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: true, data: { granted: false } });
    expect(insertProFeedback).toHaveBeenCalledTimes(1);
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
  });

  it("grants nothing on a SECOND submit, and stores nothing either", async () => {
    // The unique index on contractor_id is what refuses the row; the action
    // must stop there rather than calling the grant a second time.
    insertProFeedback.mockResolvedValue("already");
    const res = await submitProFeedbackAction({
      score: 5,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.already });
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
  });

  it("refuses a score outside 1..5 before touching the database", async () => {
    const res = await submitProFeedbackAction({
      score: 9,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.score });
    expect(insertProFeedback).not.toHaveBeenCalled();
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
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

  it("grants nothing when the store itself failed", async () => {
    insertProFeedback.mockResolvedValue("failed");
    const res = await submitProFeedbackAction({
      score: 3,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.failed });
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
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

  it("reports granted false when the grant itself refuses (already claimed)", async () => {
    // The SQL function is the authority on once-ever: it returns false on a
    // repeat and moves no money, and the action must relay that honestly
    // rather than telling the pro $5 landed.
    grantFeedbackCredit.mockResolvedValue(false);
    const res = await submitProFeedbackAction({
      score: 5,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: true, data: { granted: false } });
  });
});
