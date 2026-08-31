import { describe, it, expect, vi, beforeEach } from "vitest";

// The bug-report action, with the database mocked out. The SQL function's own
// idempotency cannot run here (there is no Postgres in vitest, see
// src/lib/proFeedback.test.ts for the assertions that cover its shape), so
// what is proved here is everything the ACTION is responsible for: validation,
// the rate limit, the qualifying gate, and the money rule - the first
// submission grants once, every later one stores words and grants nothing.

const insertProFeedback = vi.fn();
const grantFeedbackCredit = vi.fn();
const readFeedbackState = vi.fn();
const proFeedbackRateLimitOk = vi.fn();
const getCurrentContractor = vi.fn();
const isEstablishedPro = vi.fn();

vi.mock("@/lib/proFeedbackServer", () => ({
  insertProFeedback: (...a: unknown[]) => insertProFeedback(...a),
  grantFeedbackCredit: (...a: unknown[]) => grantFeedbackCredit(...a),
  readFeedbackState: (...a: unknown[]) => readFeedbackState(...a),
  proFeedbackRateLimitOk: (...a: unknown[]) => proFeedbackRateLimitOk(...a),
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
  readFeedbackState.mockResolvedValue({ sent: false, claimed: false });
  proFeedbackRateLimitOk.mockResolvedValue(true);
});

describe("submitProFeedbackAction: the money rule", () => {
  it("stores the first report and grants the credit immediately for an established pro", async () => {
    const res = await submitProFeedbackAction({
      score: 4,
      message: GOOD,
      contactOk: true,
    });
    expect(res).toEqual({ ok: true, data: { outcome: "credited" } });
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

  it("stores a LATER report but grants nothing once the credit is claimed", async () => {
    // The core of the owner's ask: the words always get through, the money
    // moves exactly once. The action must not even call the grant when the
    // claim is already on file.
    readFeedbackState.mockResolvedValue({ sent: true, claimed: true });
    const res = await submitProFeedbackAction({
      score: 2,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: true, data: { outcome: "thanks" } });
    expect(insertProFeedback).toHaveBeenCalledTimes(1);
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
  });

  it("pays exactly once when two tabs submit at the same moment", async () => {
    // Both tabs read claimed=false and both reach the grant; the SQL
    // function's promo_claims primary key pays one and refuses the other
    // (simulated here by the mock's true-then-false answers). The action must
    // relay that honestly: one "credited", one "thanks", never two credits.
    grantFeedbackCredit
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const [a, b] = await Promise.all([
      submitProFeedbackAction({ score: 4, message: GOOD, contactOk: false }),
      submitProFeedbackAction({ score: 4, message: GOOD, contactOk: false }),
    ]);
    const outcomes = [a, b].map((r) =>
      r.ok ? r.data?.outcome : "error"
    );
    expect(outcomes.filter((o) => o === "credited")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "thanks")).toHaveLength(1);
    expect(insertProFeedback).toHaveBeenCalledTimes(2);
  });

  it("stores the report but grants nothing for a pro who is not established yet", async () => {
    // Their words still reach us; the money waits, or a throwaway signup
    // plus twenty characters is a $5 vending machine. The Home tab grants it
    // later once they qualify.
    isEstablishedPro.mockResolvedValue(false);
    const res = await submitProFeedbackAction({
      score: 2,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: true, data: { outcome: "locked" } });
    expect(insertProFeedback).toHaveBeenCalledTimes(1);
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
  });

  it("reports thanks, not credited, when the grant itself refuses", async () => {
    // The SQL function is the authority on once-ever: it returns false on a
    // lost race and moves no money, and the action must relay that honestly
    // rather than telling the pro $5 landed.
    grantFeedbackCredit.mockResolvedValue(false);
    const res = await submitProFeedbackAction({
      score: 5,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: true, data: { outcome: "thanks" } });
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
    expect(grantFeedbackCredit).not.toHaveBeenCalled();
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

  it("relays 'already' while the live database still caps one row per business", async () => {
    // Only the pre-0152 window: the unique index refused the row, so the note
    // was NOT stored and no grant may run.
    insertProFeedback.mockResolvedValue("already");
    const res = await submitProFeedbackAction({
      score: 5,
      message: GOOD,
      contactOk: false,
    });
    expect(res).toEqual({ ok: false, error: FEEDBACK_ERROR_COPY.already });
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
});
