import { renderOgCard, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/ogCard";

// Social share card for this guide, built on the shared shell in
// src/lib/ogCard.tsx (same visual pattern as src/app/p/[id]/opengraph-image.tsx:
// flat light background, one accent, no gradients). Title is a literal copy
// of this folder's metadata.title in page.tsx, not an import: importing from
// page.tsx would pull its whole module graph (React components, other
// imports) into this route's bundle for the sake of one string.

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Hearth guide: Electrical panel upgrade cost: typical range and when you need one";

export default function OgImage() {
  return renderOgCard(
    "Electrical panel upgrade cost: typical range and when you need one",
    "A Hearth home guide"
  );
}
