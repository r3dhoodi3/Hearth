import { describe, it, expect } from "vitest";
import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/ogCard";

// Smoke test for the shared card every guides/pricing/pros opengraph-image.tsx
// renders through: catches a satori/ImageResponse regression (bad style prop,
// missing font, JSX satori can't render) at test time instead of at request
// time on a live share link.
describe("renderOgCard", () => {
  it("renders a short title/subtitle without throwing", () => {
    const res = renderOgCard("Pricing", "Your first home is free.");
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("renders a long, wrapping guide title without throwing", () => {
    // Longest real title in use today (socal-home-maintenance-calendar),
    // exercises the small-end of titleFontSize()'s scaling.
    const res = renderOgCard(
      "Coastal Southern California home maintenance calendar, month by month",
      "A Hearth home guide"
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
  });

  it("exports the size/contentType every colocated route file re-exports", () => {
    expect(OG_SIZE).toEqual({ width: 1200, height: 630 });
    expect(OG_CONTENT_TYPE).toBe("image/png");
  });
});
