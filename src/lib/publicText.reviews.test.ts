import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAcceptablePublicText, REVIEW_COMMENT_REJECTED } from "@/lib/publicText";

// reviews.comment is the last unreviewed free-text field printed verbatim on
// a public page (ContractorReviews.tsx, the pro's public page, and the review
// share card) that had no moderation gate. It now runs through the same
// isAcceptablePublicText() gate as the pro's business name and about section.

describe("isAcceptablePublicText on review comments", () => {
  it("accepts an ordinary review", () => {
    expect(
      isAcceptablePublicText("Great work, showed up on time, fair price.")
    ).toBe(true);
  });

  it("rejects a review carrying a phone number", () => {
    expect(
      isAcceptablePublicText("Great work, call him direct at 714-555-0100.")
    ).toBe(false);
  });

  it("rejects a review carrying a slur", () => {
    expect(isAcceptablePublicText("Retard Removal did a terrible job.")).toBe(
      false
    );
  });

  it("accepts an empty comment - a rating-only review", () => {
    expect(isAcceptablePublicText("")).toBe(true);
  });

  it("does not reject a real surname that collides with the block list", () => {
    expect(isAcceptablePublicText("Mr. Cummings did great work.")).toBe(true);
  });
});

// saveReviewAction's wiring is checked against its source rather than by
// importing and running it. src/app/(app)/contractors/actions.ts is a "use
// server" module that pulls in next/cache, next/navigation, and (through
// @/lib/parcel, @/lib/constants, @/lib/subscription, @/lib/proAlerts,
// @/lib/notify) several modules that import the "server-only" package -
// which is not an installed dependency here, so any real import of this file
// throws at module-eval time unless every one of those is mocked out too.
// src/lib/externalCallMetering.test.ts hit the same wall for this exact file
// and made the same call (see its comment above "the lazy ownership
// re-check is metered"); src/lib/publicText.test.ts already asserts the
// business-name and about-section gates the same way. Consistent with both.
describe("saveReviewAction wires the comment through the same gate", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../app/(app)/contractors/actions.ts", import.meta.url)),
    "utf8"
  );

  it("imports the gate and the rejection message", () => {
    expect(src).toContain(
      'import {\n  isAcceptablePublicText,\n  REVIEW_COMMENT_REJECTED,\n} from "@/lib/publicText";'
    );
  });

  it("refuses a non-empty flagged comment and returns REVIEW_COMMENT_REJECTED", () => {
    expect(src).toMatch(
      /if \(comment && !isAcceptablePublicText\(comment\)\) \{\s*return err\(REVIEW_COMMENT_REJECTED\);/
    );
  });

  it("checks the comment before any DB call in the function", () => {
    const fnStart = src.indexOf("export async function saveReviewAction");
    const fnBody = src.slice(fnStart);
    const gateIdx = fnBody.indexOf("isAcceptablePublicText(comment)");
    const firstDbCallIdx = fnBody.indexOf('.from("reviews")');
    const rpcIdx = fnBody.indexOf('.rpc("leave_review"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(firstDbCallIdx);
    expect(gateIdx).toBeLessThan(rpcIdx);
  });

  it("leaves an empty (rating-only) comment alone", () => {
    // comment is falsy for an empty string, so `comment && ...` short-circuits
    // and the existing rating-only path is untouched.
    expect(src).toContain('const comment = String(formData.get("comment") || "").trim();');
  });
});
