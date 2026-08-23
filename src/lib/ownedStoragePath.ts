// One guard, shared by every server action that persists a storage URL the
// CLIENT chose.
//
// The upload components put the object under a property-scoped key and then
// hand the resulting URL back through a hidden form field:
//
//   PhotoUpload.tsx      `${propertyId}/${uuid}.${ext}`        -> photo_urls
//   DocumentUpload.tsx   `${propertyId}/docs/${uuid}.${ext}`   -> file_url
//
// A server action receives whatever FormData it is handed, so those fields are
// as forgeable as any other input. Nothing downstream re-derives the path: the
// stored string is fed straight to /api/img, which signs it. Without this
// check an owner could post another property's object key (or an off-site URL)
// and have their own row point at it - a stored reference to someone else's
// document, and a signing request for a path they never uploaded.
//
// The rule is simply "the key has to sit under the property this row belongs
// to", which is exactly what the uploaders already produce, so no legitimate
// save is affected.

import { toObjectPath } from "@/lib/storage";

// Storage values are URLs or bare object keys; anything past this is not a
// real one, and an unbounded string has no business reaching a text column.
const MAX_STORED_LENGTH = 1000;

export function isOwnedStoragePath(
  value: unknown,
  propertyId: string | null | undefined
): boolean {
  if (typeof value !== "string" || typeof propertyId !== "string") return false;
  const raw = value.trim();
  if (!raw || raw.length > MAX_STORED_LENGTH) return false;
  // A property id is a UUID. Refusing anything else keeps a caller from
  // passing an empty or partial prefix that would make the startsWith below
  // match far more than it should.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      propertyId
    )
  ) {
    return false;
  }

  // Same extraction the render path uses (src/lib/storage.ts), so this checks
  // the exact string /api/img will later sign, not a different reading of it.
  const path = toObjectPath(raw);
  if (!path) return false;

  // Traversal, in raw and percent-encoded form: "<mine>/../<theirs>/x.png"
  // starts with the right prefix and resolves somewhere else entirely.
  // Backslashes are rejected for the same reason - they are not part of a
  // storage key and only show up in an attempt to confuse a normalizer.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is not something an uploader ever produces.
    return false;
  }
  if (decoded.includes("..") || decoded.includes("\\")) return false;

  // Checked in both readings so a percent-encoded prefix can't pass one and
  // resolve as the other. Strictly longer than the prefix, too: the bare
  // folder key names no object.
  const prefix = `${propertyId}/`;
  return (
    path.startsWith(prefix) &&
    decoded.startsWith(prefix) &&
    path.length > prefix.length
  );
}
