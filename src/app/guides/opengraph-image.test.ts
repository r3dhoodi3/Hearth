import { describe, it, expect } from "vitest";
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

// Guards the guides/pricing/pros share-image rollout: every guide folder
// that has a page.tsx (i.e. is a real published guide, not layout.tsx or
// the /guides index itself) must also have a colocated opengraph-image.tsx,
// or sharing that guide's link falls back to the generic site-wide card
// with no guide title on it. Catches a guide added later that forgets the
// image, and catches a size/contentType typo in an existing one.

const GUIDES_DIR = join(process.cwd(), "src/app/guides");

function guideSlugs(): string[] {
  return readdirSync(GUIDES_DIR).filter((entry) => {
    const full = join(GUIDES_DIR, entry);
    return (
      statSync(full).isDirectory() && existsSync(join(full, "page.tsx"))
    );
  });
}

describe("guide opengraph-image coverage", () => {
  const slugs = guideSlugs();

  it("found the guide directories to check (sanity check for the glob above)", () => {
    // If this drops to 0, the directory scan itself is broken, not the
    // thing it's meant to be checking - fail loudly rather than passing
    // an empty suite.
    expect(slugs.length).toBeGreaterThan(0);
  });

  it.each(slugs)("guides/%s has an opengraph-image.tsx", (slug) => {
    expect(existsSync(join(GUIDES_DIR, slug, "opengraph-image.tsx"))).toBe(
      true
    );
  });

  it.each(slugs)("guides/%s/opengraph-image.tsx exports a 1200x630 png card", async (slug) => {
    const mod = await import(
      /* @vite-ignore */ `./${slug}/opengraph-image.tsx`
    );
    expect(mod.size).toEqual({ width: 1200, height: 630 });
    expect(mod.contentType).toBe("image/png");
    expect(typeof mod.default).toBe("function");
    expect(typeof mod.alt).toBe("string");
    expect(mod.alt.length).toBeGreaterThan(0);

    // Actually render this guide's real title/subtitle, not just the probe
    // strings in ogCard.test.ts - catches a satori failure specific to one
    // guide's own title text (length, punctuation) that a generic probe
    // wouldn't.
    const res = mod.default();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
  });
});
