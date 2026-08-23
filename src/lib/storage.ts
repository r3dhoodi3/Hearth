// Helpers for serving files from the (now private) home-photos bucket.
//
// Objects are stored with a value that is either a full Supabase public URL
// (legacy rows / getPublicUrl output) or a bare object path. Either way we only
// need the object PATH, then we serve it through /api/img, which signs a short
// lived URL gated by the caller's RLS. Never render a stored URL directly - the
// bucket is private, so a raw public URL would 400.

const BUCKET_MARKER = "/home-photos/";

// Extract the object path within the bucket from a stored value.
//
// The query string and fragment are cut off FIRST. A stored value can be a
// getPublicUrl() result, and Supabase appends `?t=...` to those for cache
// busting; a signed URL carries a whole `?token=...` on it. Left on, that
// suffix rode along as part of the object key - so /api/img asked storage to
// sign "abc.jpg?t=123", which is not an object, and (worse) the same suffix
// went through isOwnedStoragePath (src/lib/ownedStoragePath.ts), where a
// query string is attacker-controlled text sitting inside what is supposed to
// be a plain key.
export function toObjectPath(value: string | null | undefined): string | null {
  if (!value) return null;
  // Cut at whichever comes first: "a.jpg#x?y" is a fragment, not a query.
  const cut = value.search(/[?#]/);
  const clean = cut === -1 ? value : value.slice(0, cut);
  if (!clean) return null;
  const i = clean.indexOf(BUCKET_MARKER);
  if (i !== -1) return clean.slice(i + BUCKET_MARKER.length) || null;
  // Already a bare path (possibly with a leading "home-photos/").
  return clean.replace(/^home-photos\//, "") || null;
}

// The authenticated image proxy URL for a stored value. Use this for any
// <img src> / <a href> that points at a home-photos object.
export function imgSrc(value: string | null | undefined): string | null {
  const path = toObjectPath(value);
  if (!path) return null;
  return `/api/img?path=${encodeURIComponent(path)}`;
}
