import { describe, it, expect } from "vitest";
import OgImage, { size, contentType, alt } from "./opengraph-image";

describe("pricing opengraph-image", () => {
  it("is a 1200x630 png card", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(alt.length).toBeGreaterThan(0);
  });

  it("renders without throwing", () => {
    const res = OgImage();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
  });
});
