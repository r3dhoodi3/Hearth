import { describe, it, expect } from "vitest";
import {
  convertedRef,
  isConvertedRef,
  reservedSessionId,
  reservedSessionRef,
  PLUS_RESERVATION_REF,
  PRO_RESERVATION_REF,
} from "./promoClaimRef";

describe("promo claim refs", () => {
  it("round-trips a reserved session id", () => {
    const ref = reservedSessionRef(PLUS_RESERVATION_REF, "cs_test_1");
    expect(ref).toBe("plus_checkout_reservation:cs_test_1");
    expect(reservedSessionId(PLUS_RESERVATION_REF, ref)).toBe("cs_test_1");
  });

  it("reads a bare reservation as NO session", () => {
    // This is the case that has to fail closed: a bare marker means another
    // attempt is mid-flight, not that a checkout was abandoned. Handing the
    // offer back here would be the two-tabs double-trial the reservation
    // exists to prevent.
    expect(
      reservedSessionId(PLUS_RESERVATION_REF, PLUS_RESERVATION_REF)
    ).toBeNull();
    expect(
      reservedSessionId(PLUS_RESERVATION_REF, `${PLUS_RESERVATION_REF}:`)
    ).toBeNull();
  });

  it("reads a spent claim as no session, whatever it says", () => {
    for (const ref of [
      convertedRef("sub_1"),
      "backfill:0071",
      null,
      undefined,
      "",
    ]) {
      expect(reservedSessionId(PLUS_RESERVATION_REF, ref)).toBeNull();
    }
  });

  it("never reads the other side's reservation", () => {
    const proRef = reservedSessionRef(PRO_RESERVATION_REF, "cs_test_2");
    expect(reservedSessionId(PLUS_RESERVATION_REF, proRef)).toBeNull();
    expect(reservedSessionId(PRO_RESERVATION_REF, proRef)).toBe("cs_test_2");
  });

  it("recognizes a converted claim", () => {
    expect(isConvertedRef(convertedRef("sub_1"))).toBe(true);
    expect(isConvertedRef(PLUS_RESERVATION_REF)).toBe(false);
    expect(isConvertedRef(null)).toBe(false);
  });
});
