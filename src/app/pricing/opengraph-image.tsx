import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/ogCard";

// Social share card for /pricing, built on the shared shell in
// src/lib/ogCard.tsx (same visual pattern as
// src/app/p/[id]/opengraph-image.tsx: flat light background, one accent, no
// gradients). Subtitle price is the same $1.99/week figure page.tsx and
// PlanToggle.tsx already print (PLUS_PLAN.weekly), copied as a literal here
// since satori/ImageResponse renders in a separate route from the page.

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Hearth pricing";

export default function OgImage() {
  return renderOgCard(
    "Pricing",
    "Your first home is free. Hearth Plus starts at $1.99/week."
  );
}
