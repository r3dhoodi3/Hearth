"use client";

import { useEffect } from "react";
import { FINGERPRINT_COOKIE } from "@/lib/risk/cookies";

// A coarse browser fingerprint, written to a first-party cookie so the server
// can use it as one input to the free-trial abuse score.
//
// Rendered on the sign-in and the two sign-up pages only. It is NOT on any
// signed-in page, and it is not on the marketing site: the only question it
// helps answer is "is this the same browser that made the last four accounts",
// and that question is only ever asked at the account door.
//
// WHAT IT COLLECTS, and why this list and no more:
//   user agent, screen size, timezone offset, language, CPU core count
// All five are values the browser hands to every site that asks, none of them
// is unique on its own, and together they are just distinctive enough to
// survive a private window - which is the whole point, because a private window
// clears the device cookie. They are hashed here and never sent as plain text.
//
// It is deliberately weak. There is no canvas render, no WebGL probe, no audio
// context, no font enumeration - the techniques that make a fingerprint
// genuinely unique and genuinely creepy. A farmer with a second browser profile
// defeats this in a minute, which is fine: it is worth 20 points in a
// hundred-point score, not a wall.
//
// Renders nothing.

// Hash client-side so the raw values never travel, using the Web Crypto API
// that every browser this app supports already has. Unsalted (the salt is a
// server secret), which is exactly why src/lib/risk/signals.ts hashes the
// result AGAIN with the server salt before storing it.
async function fingerprintHash(): Promise<string | null> {
  try {
    const parts = [
      navigator.userAgent ?? "",
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      String(new Date().getTimezoneOffset()),
      navigator.language ?? "",
      String(navigator.hardwareConcurrency ?? ""),
    ].join("|");

    const bytes = new TextEncoder().encode(parts);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Old browser, hardened privacy setting, insecure context: no fingerprint.
    // The score simply does without it.
    return null;
  }
}

export default function DeviceFingerprint() {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hash = await fingerprintHash();
      if (cancelled || !hash) return;
      try {
        // 400 days, the ceiling browsers honour, matching the device cookie.
        // SameSite=Lax so it rides an ordinary form post but not a cross-site
        // one; Secure everywhere except plain-http local development, where the
        // browser would drop it.
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${FINGERPRINT_COOKIE}=${hash}; Max-Age=${
          400 * 24 * 60 * 60
        }; Path=/; SameSite=Lax${secure}`;
      } catch {
        // Cookies blocked. Nothing to do, and nothing to tell the user: this is
        // not a feature they asked for.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
