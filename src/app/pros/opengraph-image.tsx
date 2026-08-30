import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/ogCard";

// Social share card for /pros, built on the shared shell in
// src/lib/ogCard.tsx (same visual pattern as
// src/app/p/[id]/opengraph-image.tsx: flat light background, one accent, no
// gradients).

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Hearth for Pros";

export default function OgImage() {
  return renderOgCard(
    "Hearth for Pros",
    "Real local leads. Pay only when you apply."
  );
}
