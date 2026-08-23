import { describe, expect, it } from "vitest";
import { isOwnedStoragePath } from "@/lib/ownedStoragePath";

const MINE = "11111111-2222-3333-4444-555555555555";
const THEIRS = "99999999-8888-7777-6666-555555555555";
const BASE = "https://proj.supabase.co/storage/v1/object/public/home-photos";

describe("isOwnedStoragePath", () => {
  it("accepts what the uploaders actually produce", () => {
    // PhotoUpload.tsx
    expect(isOwnedStoragePath(`${BASE}/${MINE}/abc.jpg`, MINE)).toBe(true);
    // DocumentUpload.tsx
    expect(isOwnedStoragePath(`${BASE}/${MINE}/docs/abc.pdf`, MINE)).toBe(true);
    // A bare object key, with or without the bucket name in front.
    expect(isOwnedStoragePath(`${MINE}/abc.jpg`, MINE)).toBe(true);
    expect(isOwnedStoragePath(`home-photos/${MINE}/abc.jpg`, MINE)).toBe(true);
  });

  it("rejects another property's object", () => {
    expect(isOwnedStoragePath(`${BASE}/${THEIRS}/abc.jpg`, MINE)).toBe(false);
    expect(isOwnedStoragePath(`${THEIRS}/docs/abc.pdf`, MINE)).toBe(false);
  });

  it("rejects traversal out of the prefix, encoded or not", () => {
    expect(isOwnedStoragePath(`${BASE}/${MINE}/../${THEIRS}/a.jpg`, MINE)).toBe(
      false
    );
    expect(
      isOwnedStoragePath(`${BASE}/${MINE}/%2e%2e/${THEIRS}/a.jpg`, MINE)
    ).toBe(false);
    expect(isOwnedStoragePath(`${BASE}/${MINE}\\..\\a.jpg`, MINE)).toBe(false);
  });

  it("rejects an off-site URL", () => {
    expect(isOwnedStoragePath("https://evil.example/a.jpg", MINE)).toBe(false);
    // The bucket marker appearing in someone else's URL is not ownership, but
    // it is only refused because the prefix after it is not this property.
    expect(
      isOwnedStoragePath(`https://evil.example/home-photos/${THEIRS}/a.jpg`, MINE)
    ).toBe(false);
  });

  it("rejects the bare folder, blanks, non-strings, and oversized values", () => {
    expect(isOwnedStoragePath(`${MINE}/`, MINE)).toBe(false);
    expect(isOwnedStoragePath(MINE, MINE)).toBe(false);
    expect(isOwnedStoragePath("", MINE)).toBe(false);
    expect(isOwnedStoragePath("   ", MINE)).toBe(false);
    expect(isOwnedStoragePath(null, MINE)).toBe(false);
    expect(isOwnedStoragePath(`${MINE}/${"a".repeat(1000)}.jpg`, MINE)).toBe(
      false
    );
  });

  it("refuses to run against a property id that isn't a UUID", () => {
    // A blank or partial prefix would otherwise match far too much.
    expect(isOwnedStoragePath(`${MINE}/abc.jpg`, "")).toBe(false);
    expect(isOwnedStoragePath(`${MINE}/abc.jpg`, "1111")).toBe(false);
    expect(isOwnedStoragePath(`${MINE}/abc.jpg`, null)).toBe(false);
  });
});
