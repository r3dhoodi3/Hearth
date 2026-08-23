import { describe, expect, it } from "vitest";
import { imgSrc, toObjectPath } from "@/lib/storage";

const PROPERTY = "11111111-2222-3333-4444-555555555555";
const KEY = `${PROPERTY}/photo.jpg`;
const PUBLIC_URL = `https://xyz.supabase.co/storage/v1/object/public/home-photos/${KEY}`;

describe("toObjectPath", () => {
  it("reads a bare key, with or without the bucket prefix", () => {
    expect(toObjectPath(KEY)).toBe(KEY);
    expect(toObjectPath(`home-photos/${KEY}`)).toBe(KEY);
  });

  it("reads the key out of a stored public URL", () => {
    expect(toObjectPath(PUBLIC_URL)).toBe(KEY);
  });

  // getPublicUrl() appends a "?t=" cache buster and a signed URL carries a
  // whole "?token=...". Left on, that suffix became part of the object key -
  // so the sign request named an object that does not exist, and the same
  // attacker-controlled text went through isOwnedStoragePath as if it were a
  // plain key.
  it("drops the query string and the fragment", () => {
    expect(toObjectPath(`${PUBLIC_URL}?t=1699999999`)).toBe(KEY);
    expect(toObjectPath(`${PUBLIC_URL}?token=abc.def.ghi`)).toBe(KEY);
    expect(toObjectPath(`${KEY}?t=1`)).toBe(KEY);
    expect(toObjectPath(`${KEY}#frag`)).toBe(KEY);
    // Whichever comes first wins: "#" opens a fragment, so a "?" inside it is
    // part of the fragment, not a query.
    expect(toObjectPath(`${KEY}#a?b`)).toBe(KEY);
  });

  it("returns null for nothing to read", () => {
    expect(toObjectPath(null)).toBeNull();
    expect(toObjectPath(undefined)).toBeNull();
    expect(toObjectPath("")).toBeNull();
    // A value that is nothing BUT a query string names no object.
    expect(toObjectPath("?t=1")).toBeNull();
    expect(toObjectPath("home-photos/")).toBeNull();
  });
});

describe("imgSrc", () => {
  it("points at the signing proxy with the encoded key", () => {
    expect(imgSrc(`${PUBLIC_URL}?t=1`)).toBe(
      `/api/img?path=${encodeURIComponent(KEY)}`
    );
    expect(imgSrc(null)).toBeNull();
  });
});
