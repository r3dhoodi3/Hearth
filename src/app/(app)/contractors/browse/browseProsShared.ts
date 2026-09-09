// Plain constants/types shared between page.tsx (server) and
// BrowseProsBoard.tsx (client). MIN_RATING_OPTIONS has to live somewhere
// that is NOT a "use client" file: Next's client-reference machinery turns
// every export of a "use client" module into a proxy for code-splitting
// purposes, including plain non-component values, so a server component that
// imports a runtime array straight out of a client file gets a reference
// object back instead of the array (this broke page.tsx's parseMinRating
// with "MIN_RATING_OPTIONS.includes is not a function" until this file was
// split out - C8, 2026-09-07).

export type BrowsePro = {
  id: string;
  slug: string | null;
  name: string;
  categories: string[];
  rating: number | null;
  review_count: number;
  has_license: boolean;
  license_verified_at: string | null;
  background_checked_at: string | null;
  logo_url: string | null;
  service_area: string | null;
  project_count: number;
  has_insurance?: boolean | null;
  yelp_url?: string | null;
  google_reviews_url?: string | null;
  latest_review_comment?: string | null;
  latest_review_rating?: number | null;
  photo_urls?: string[] | null;
  created_at?: string | null;
};

// B9: minimum-rating filter options. 0 means "Any" (no filter). A pro with no
// rating yet (hasRating false on the card) never matches a nonzero minimum -
// there is nothing to compare, and showing an unrated pro under "4+ stars"
// would be a lie the filter itself is making.
export const MIN_RATING_OPTIONS = [0, 3, 4, 4.5] as const;

// browse_pros() applies its `limit 200` AFTER its category filter, so the
// unfiltered call this page now makes returns the top 200 pros overall. Below
// that count, filtering in the browser is exactly what a per-category server
// call would have returned. AT that count the list is truncated, and a
// client-side category filter would silently hide every matching pro ranked
// past 200 - so at the cap the category chips go back to a server round trip
// (page.tsx re-asks browse_pros for that one category). Today's launch market
// is nowhere near 200 pros; this is the guard that keeps the fast path honest
// when it is. Keep in step with the `limit` in migration 0114's browse_pros.
export const BROWSE_PROS_ROW_CAP = 200;
