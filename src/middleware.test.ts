import { describe, expect, it } from "vitest";
import { config } from "@/middleware";

// The matcher decides which requests pay for a session refresh. It has to keep
// letting every real page through while skipping the files served straight out
// of /public, so it is worth pinning both halves down.
const matches = (path: string) =>
  config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));

describe("middleware matcher", () => {
  it("runs on app pages and API routes", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/dashboard")).toBe(true);
    expect(matches("/pro")).toBe(true);
    expect(matches("/pro/billing?need=20.00")).toBe(true);
    expect(matches("/api/pro-ask")).toBe(true);
  });

  it("skips Next internals", () => {
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
  });

  it("skips public static assets, including the demo voiceover audio", () => {
    for (const asset of [
      "/demo-vo/hook.mp3",
      "/photos/plumber-pipe-fittings.jpg",
      "/icon.svg",
      "/logo.png",
      "/hero.webp",
      "/fonts/inter.woff2",
      "/robots.txt",
      "/sitemap.xml",
      "/site.webmanifest",
    ]) {
      expect(matches(asset), asset).toBe(false);
    }
  });
});
